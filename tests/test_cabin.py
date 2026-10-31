"""Tests for the cabin audio module. Run: python3 -m unittest tests.test_cabin"""

import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import stratos_cabin  # noqa: E402


class FakeHandle:
    def __init__(self):
        self.stopped = False

    def stop(self):
        self.stopped = True


def write_wav(path, seconds=0.4, amplitude=10000):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    frames = int(24000 * seconds)
    with wave.open(path, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(24000)
        target.writeframes(struct.pack("<%dh" % frames, *([amplitude] * frames)))


def peak(path):
    with wave.open(path, "rb") as source:
        raw = source.readframes(source.getnframes())
    return max(abs(value) for value in struct.unpack("<%dh" % (len(raw) // 2), raw))


class CabinAudioTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="stratos-cabin-")
        self.opened = []
        self.handles = []
        self._env = dict(os.environ)
        os.environ.pop("ELEVENLABS_API_KEY", None)

        def opener(path):
            handle = FakeHandle()
            self.handles.append(handle)
            self.opened.append(path)
            return handle

        self.audio = stratos_cabin.CabinAudio(self.directory, opener=opener, available=lambda: True)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def add_pack(self, slot="crew-female", announcement="arr.welcome", amplitude=10000, seconds=0.4):
        write_wav(os.path.join(self.directory, "cabin", "voices", slot, announcement + ".wav"),
                  seconds=seconds, amplitude=amplitude)
        with open(os.path.join(self.directory, "cabin", "voices", "pack.json"), "w", encoding="utf-8") as handle:
            handle.write('{"name":"Test pack","licence":"CC BY 4.0","source":"recorded for this test"}')

    def test_efb_output_skips_the_xplane_plugin_and_serves_the_wav(self):
        self.add_pack()
        snapshot = self.audio.play("arr.welcome", "crew-female", "Welcome to Frankfurt.", output="efb")
        self.assertEqual(snapshot["output"]["kind"], "efb")
        self.assertEqual(self.opened, [], "the X-Plane plugin is not used for EFB output")
        data = self.audio.audio_bytes()
        self.assertIsNotNone(data)
        self.assertEqual(data[:4], b"RIFF")

    def test_xplane_output_does_not_serve_bytes_to_the_efb(self):
        self.add_pack()
        self.audio.play("arr.welcome", "crew-female", "Welcome to Frankfurt.", output="xplane")
        self.assertEqual(len(self.opened), 1)
        self.assertIsNone(self.audio.audio_bytes())

    def test_unknown_output_is_refused(self):
        self.add_pack()
        with self.assertRaises(stratos_cabin.CabinError):
            self.audio.play("arr.welcome", "crew-female", "Welcome to Frankfurt.", output="speaker")

    def test_without_a_voice_source_it_refuses(self):
        self.assertFalse(self.audio.ready())
        with self.assertRaises(stratos_cabin.CabinError) as caught:
            self.audio.play("arr.welcome", "crew-female", "Welcome to Frankfurt.")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.opened, [], "no audio is played without a source")

    def test_a_recorded_pack_plays_and_names_its_licence(self):
        self.add_pack()
        self.assertTrue(self.audio.ready())
        state = self.audio.state()
        self.assertEqual(state["pack"]["licence"], "CC BY 4.0")
        self.assertEqual(state["voices"][3]["recorded"], 1)
        played = self.audio.play("arr.welcome", "crew-female", "Welcome to Frankfurt.")
        self.assertEqual(played["playing"]["source"], "pack")
        self.assertAlmostEqual(played["playing"]["duration"], 0.4, places=1)
        self.assertTrue(os.path.isfile(self.opened[0]))

    def test_volume_is_baked_into_the_played_file(self):
        self.add_pack(amplitude=10000)
        self.audio.control("volume", 0.5)
        self.audio.play("arr.welcome", "crew-female", "Welcome to Frankfurt.")
        self.assertAlmostEqual(peak(self.opened[0]) / 10000.0, 0.5, places=2)

    def test_pause_resume_and_stop(self):
        self.add_pack(seconds=1.2)
        self.audio.control("volume", 1.0)
        self.audio.play("arr.welcome", "crew-female", "Welcome to Frankfurt.")
        time.sleep(0.12)
        paused = self.audio.control("pause")
        self.assertTrue(paused["playing"]["paused"])
        self.assertGreater(paused["playing"]["position"], 0)
        self.assertTrue(self.handles[0].stopped)

        resumed = self.audio.control("resume")
        self.assertFalse(resumed["playing"]["paused"])
        self.assertEqual(len(self.opened), 2)
        self.assertIn("trim-", self.opened[1])

        stopped = self.audio.control("stop")
        self.assertIsNone(stopped["playing"])

    def test_bad_input_is_refused_before_anything_is_opened(self):
        self.add_pack()
        for announcement, slot, text in (
            ("../bridge_token", "crew-female", "x"),
            ("Bad Id", "crew-female", "x"),
            ("arr.welcome", "narrator", "x"),
            ("arr.welcome", "crew-female", " "),
            ("arr.welcome", "crew-female", "x" * 800),
        ):
            with self.assertRaises(stratos_cabin.CabinError):
                self.audio.play(announcement, slot, text)
        self.assertEqual(self.opened, [])

    def test_a_missing_audio_device_is_reported(self):
        silent = stratos_cabin.CabinAudio(self.directory, opener=lambda path: FakeHandle(),
                                          available=lambda: False)
        self.assertFalse(silent.ready())
        self.assertFalse(silent.state()["output"]["available"])
        with self.assertRaises(stratos_cabin.CabinError) as caught:
            silent.play("arr.welcome", "crew-female", "Welcome.")
        self.assertEqual(caught.exception.status, 503)

    def test_the_output_is_the_xplane_bus(self):
        state = self.audio.state()
        self.assertEqual(state["output"]["kind"], "xplane")
        self.assertIn("X-Plane", state["output"]["bus"])
        self.assertFalse(state["provider"]["configured"])

    def test_a_configured_neural_voice_is_reported(self):
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        provider = stratos_cabin.CabinAudio(self.directory, opener=lambda path: FakeHandle(),
                                           available=lambda: True)
        state = provider.state()
        self.assertTrue(state["ready"])
        self.assertTrue(state["provider"]["configured"])
        self.assertEqual(state["provider"]["name"], "ElevenLabs")


class PluginHandleTest(unittest.TestCase):
    """The bridge reports playing only when the X-Plane plugin answers OK."""

    def setUp(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.settimeout(2)
        self._addr = stratos_cabin.PLUGIN_ADDR
        stratos_cabin.PLUGIN_ADDR = self.server.getsockname()

    def tearDown(self):
        stratos_cabin.PLUGIN_ADDR = self._addr
        self.server.close()

    def test_ok_reply_starts_playback(self):
        handle = stratos_cabin._PluginHandle("C:\\clip one.wav", 1.0)
        self.server_reply = b"OK"
        threading.Thread(target=self._reply_once, args=(b"OK",), daemon=True).start()
        self.assertIs(handle.start(), handle)

    def test_err_reply_is_raised(self):
        threading.Thread(target=self._reply_once, args=(b"ERR path",), daemon=True).start()
        with self.assertRaises(OSError) as caught:
            stratos_cabin._PluginHandle("x.wav", 1.0).start()
        self.assertIn("ERR path", str(caught.exception))

    def test_silent_plugin_times_out(self):
        with self.assertRaises(OSError) as caught:
            stratos_cabin._PluginHandle("x.wav", 1.0).start()
        self.assertIn("not responding", str(caught.exception))

    def _reply_once(self, reply):
        _, sender = self.server.recvfrom(1024)
        self.server.sendto(reply, sender)


if __name__ == "__main__":
    unittest.main()
