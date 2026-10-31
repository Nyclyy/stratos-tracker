"""Cabin announcement audio.

The EFB on the tablet decided what to say; this module decides whether the PC
can say it, and says it.

Voice sources, in order
  1. A recorded pack: ``<data>/cabin/voices/<slot>/<announcement-id>.wav`` plus an
     optional ``pack.json`` naming the recording, its licence and its source.
  2. ElevenLabs text-to-speech, when ``ELEVENLABS_API_KEY`` is set in the
     environment. The sentence is synthesised once and the WAV is cached.
  With neither, playback refuses. It never substitutes a system voice.

Output
  The audio goes to X-Plane's master sound bus through the Stratos X-Plane
  plugin (127.0.0.1:49410). Playback counts as started only after the plugin
  replies OK. Nothing is played on the PC's default audio device.

Standard library only, like the rest of the bridge.
"""

import hashlib
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave

# ElevenLabs voice IDs. A slot with no voice ID cannot be synthesised; it can
# still play a recorded pack. Add IDs here, or set STRATOS_VOICE_<SLOT> (for
# example STRATOS_VOICE_CAPTAIN_FEMALE) without editing this file.
SLOTS = {
    "captain-male": {"label": "Captain · male", "voice": "BbabEUYdj0SPh7rShWry"},
    "captain-female": {"label": "Captain · female", "voice": ""},
    "crew-male": {"label": "Cabin crew · male", "voice": ""},
    "crew-female": {"label": "Cabin crew · female", "voice": "sJFvtNTcZ7jbhIbDe2Xb"},
}
ELEVEN_URL = "https://api.elevenlabs.io/v1/text-to-speech/%s?output_format=pcm_22050"
ELEVEN_MODEL = "eleven_multilingual_v2"


def _voice_id(slot):
    override = os.environ.get("STRATOS_VOICE_" + slot.replace("-", "_").upper(), "").strip()
    return override or SLOTS[slot]["voice"]

ID_RE = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
MAX_TEXT = 700
CACHE_MAX_AGE = 24 * 3600
AUDIO_BUS_NOTE = ("Plays on X-Plane's master sound bus through the Stratos X-Plane plugin.")
# Where an announcement plays: the X-Plane plugin on the PC, or the EFB tablet.
OUTPUTS = ("xplane", "efb")


class CabinError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _default_available():
    # The X-Plane plugin is probed when playback starts; see _PluginHandle.start().
    return True


PLUGIN_ADDR = ("127.0.0.1", 49410)
PLUGIN_BUS_MASTER = 10  # xplm_Master in XPLMSound.h


class _PluginHandle:
    """Playback on the X-Plane audio bus, via the Stratos cabin plugin."""

    def __init__(self, path, gain):
        self.path = path
        self.gain = gain

    def start(self):
        """Send PLAY and wait for the plugin's OK. Raises if X-Plane did not start it."""
        message = "PLAY %d %.3f %s" % (PLUGIN_BUS_MASTER, self.gain, self.path)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1.5)
            sock.sendto(message.encode("utf-8"), PLUGIN_ADDR)
            try:
                reply, _ = sock.recvfrom(256)
            except socket.timeout:
                raise OSError("The Stratos X-Plane plugin is not responding. Is X-Plane running with the plugin enabled?")
        if reply.strip() != b"OK":
            raise OSError("The Stratos X-Plane plugin refused the audio (%s)." % reply.decode("utf-8", "replace").strip())
        return self

    def stop(self):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.sendto(b"STOP", PLUGIN_ADDR)
        except OSError:
            pass


def _default_opener(path):
    # Gain is already baked into the file, so the plugin plays it at unity.
    return _PluginHandle(path, 1.0).start()


def _wav_duration(path):
    with wave.open(path, "rb") as source:
        return source.getnframes() / float(source.getframerate() or 1)


def _scale_wav(source_path, target_path, gain):
    """Write a copy with the sample amplitude multiplied by ``gain``."""
    with wave.open(source_path, "rb") as source:
        params = source.getparams()
        raw = source.readframes(source.getnframes())
    if params.sampwidth == 2 and len(raw) % 2 == 0:
        samples = struct.unpack("<%dh" % (len(raw) // 2), raw)
        raw = struct.pack("<%dh" % len(samples),
                          *(max(-32768, min(32767, int(sample * gain))) for sample in samples))
    with wave.open(target_path, "wb") as target:
        target.setparams(params)
        target.writeframes(raw)
    return target_path


def _trim_wav(source_path, target_path, offset, duration):
    with wave.open(source_path, "rb") as source:
        rate = source.getframerate() or 1
        params = source.getparams()
        start = max(0, int(offset * rate))
        source.setpos(min(start, source.getnframes()))
        raw = source.readframes(int(max(0.0, duration) * rate))
    with wave.open(target_path, "wb") as target:
        target.setparams(params)
        target.writeframes(raw)
    return target_path


class CabinAudio:
    """One player for the whole bridge: an announcement at a time, by design."""

    def __init__(self, data_dir, opener=None, available=None, log=None):
        self.root = os.path.join(data_dir, "cabin")
        self.voices_dir = os.path.join(self.root, "voices")
        self.cache_dir = os.path.join(self.root, "cache")
        os.makedirs(self.cache_dir, exist_ok=True)
        self._opener = opener or _default_opener
        self._available = available or _default_available
        self._log = log or (lambda message: None)
        self._lock = threading.Lock()
        self._synth_lock = threading.Lock()
        self._handle = None
        self._efb_file = ""
        self._volume = 0.8
        self._synthed = []
        self._error = ""
        self._state = self._blank()
        self._prune()

    @staticmethod
    def _blank():
        return {"id": "", "slot": "", "source": "", "path": "", "started": 0.0,
                "position": 0.0, "duration": 0.0, "paused": False}

    def _prune(self):
        cutoff = time.time() - CACHE_MAX_AGE
        for name in os.listdir(self.cache_dir):
            if not name.startswith(("play-", "trim-")):
                continue
            path = os.path.join(self.cache_dir, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass

    # ── sources ────────────────────────────────────────────────────
    def _key(self):
        return os.environ.get("ELEVENLABS_API_KEY", "").strip()

    def provider_configured(self):
        return bool(self._key())

    def _pack_meta(self):
        try:
            with open(os.path.join(self.voices_dir, "pack.json"), encoding="utf-8") as handle:
                data = json.load(handle)
            return {
                "name": str(data.get("name") or "")[:80],
                "licence": str(data.get("licence") or "")[:120],
                "source": str(data.get("source") or "")[:160],
                "recordedAt": str(data.get("recordedAt") or "")[:24],
            }
        except Exception:
            return None

    def _pack_file(self, slot, announcement):
        path = os.path.join(self.voices_dir, slot, announcement + ".wav")
        return path if os.path.isfile(path) else None

    def inventory(self):
        voices = []
        for slot, info in SLOTS.items():
            folder = os.path.join(self.voices_dir, slot)
            files = []
            if os.path.isdir(folder):
                files = sorted(name[:-4] for name in os.listdir(folder)
                               if name.endswith(".wav") and ID_RE.match(name[:-4]))
            # The page enables a tile only when this slot can actually speak it.
            voices.append({"slot": slot, "label": info["label"], "recorded": len(files),
                           "files": files[:400], "provider": self.provider_configured()})
        return voices

    def _any_recorded(self):
        return any(voice["recorded"] for voice in self.inventory())

    def ready(self):
        return bool(self._available() and (self.provider_configured() or self._any_recorded()))

    def _synthesize(self, text, slot):
        key = self._key()
        voice = _voice_id(slot)
        if not key:
            raise CabinError("ELEVENLABS_API_KEY is not set on this PC.", 409)
        if not voice:
            raise CabinError("No ElevenLabs voice is configured for this slot.", 409)
        digest = hashlib.sha1(("%s|%s|%s" % (voice, ELEVEN_MODEL, text)).encode("utf-8")).hexdigest()[:16]
        target = os.path.join(self.cache_dir, "tts-%s.wav" % digest)
        if os.path.isfile(target) and os.path.getsize(target) > 64:
            return target
        with self._synth_lock:
            if os.path.isfile(target) and os.path.getsize(target) > 64:
                return target
            now = time.time()
            self._synthed = [stamp for stamp in self._synthed if now - stamp < 3600]
            if len(self._synthed) >= 60:
                raise CabinError("Too many announcements synthesised this hour. Try again later.", 429)
            body = json.dumps({"text": text, "model_id": ELEVEN_MODEL}).encode("utf-8")
            request = urllib.request.Request(
                ELEVEN_URL % voice,
                data=body,
                headers={
                    "xi-api-key": key,
                    "Content-Type": "application/json",
                    "Accept": "audio/pcm",
                    "User-Agent": "Stratos-Cabin",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    pcm = response.read()
            except urllib.error.HTTPError as error:
                detail = "ElevenLabs answered %s." % error.code
                if error.code in (401, 403):
                    detail = "ElevenLabs rejected the configured API key."
                raise CabinError(detail, 502)
            except Exception as error:
                raise CabinError("Could not reach ElevenLabs: %s" % error, 502)
            if len(pcm) < 64:
                raise CabinError("ElevenLabs returned no audio.", 502)
            # The API returns raw 16-bit mono PCM at 22050 Hz; wrap it as WAV.
            with wave.open(target, "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(22050)
                out.writeframes(pcm)
            self._synthed.append(now)
            self._log("cabin: synthesised %s (%d bytes)" % (slot, len(pcm)))
        return target

    # ── state ──────────────────────────────────────────────────────
    def _position_locked(self, now):
        state = self._state
        if not state["id"] or state["paused"]:
            return state["position"]
        return min(state["duration"], state["position"] + (now - state["started"]))

    def _playing_locked(self, now):
        state = self._state
        if not state["id"]:
            return None
        position = self._position_locked(now)
        if position >= state["duration"] - 0.05:
            self._finish_locked()
            return None
        return {
            "id": state["id"],
            "slot": state["slot"],
            "source": state["source"],
            "position": round(position, 2),
            "duration": round(state["duration"], 2),
            "paused": bool(state["paused"]),
        }

    def _finish_locked(self):
        if self._handle is not None:
            self._handle.stop()
            self._handle = None
        self._state = self._blank()

    def _snapshot_locked(self):
        return {
            "ready": self.ready(),
            "output": {"kind": self._state.get("output") or "xplane", "available": bool(self._available()),
                        "bus": AUDIO_BUS_NOTE},
            "provider": {"name": "ElevenLabs" if self.provider_configured() else "",
                         "configured": self.provider_configured()},
            "pack": self._pack_meta(),
            "voices": self.inventory(),
            "volume": self._volume,
            "playing": self._playing_locked(time.time()),
            "error": self._error,
        }

    def state(self):
        with self._lock:
            return self._snapshot_locked()

    # ── playback ───────────────────────────────────────────────────
    def play(self, announcement, slot, text, output="xplane", volume=None):
        announcement = str(announcement or "").strip()
        slot = str(slot or "").strip()
        text = " ".join(str(text or "").split())
        output = str(output or "xplane").strip()
        if not ID_RE.match(announcement or ""):
            raise CabinError("Unknown announcement.")
        if slot not in SLOTS:
            raise CabinError("Unknown voice slot.")
        if len(text) < 2 or len(text) > MAX_TEXT:
            raise CabinError("The announcement text is empty or too long.")
        if output not in OUTPUTS:
            raise CabinError("Unknown audio output.")
        # The EFB plays the file itself, so only the X-Plane route needs the PC's player.
        efb = output == "efb"
        if not efb and not self._available():
            raise CabinError("No audio player is available on this PC.", 503)

        # Resolve the audio before taking the playback lock: synthesis can take
        # seconds, and the page polls this module while it happens.
        path = self._pack_file(slot, announcement)
        source = "pack" if path else "provider"
        try:
            if not path:
                path = self._synthesize(text, slot)
            duration = _wav_duration(path)
        except CabinError as error:
            with self._lock:
                self._error = str(error)
            raise

        if volume is not None:
            self.set_volume(volume)
        with self._lock:
            self._error = ""
            self._finish_locked()
            self._start_locked(path, duration, 0.0, announcement, slot, source, efb=efb)
            return self._snapshot_locked()

    def audio_bytes(self):
        """The WAV the EFB should play now, or None when the bridge is not handing one out."""
        with self._lock:
            if self._state.get("output") != "efb" or not self._efb_file:
                return None
            if self._playing_locked(time.time()) is None:
                return None
            path = self._efb_file
        with open(path, "rb") as handle:
            return handle.read()

    def _start_locked(self, path, duration, offset, announcement, slot, source, efb=False):
        # The EFB applies its own volume to the audio it plays, so the file it is
        # given is never scaled here: a slider change then does not restart it.
        gain = 1.0 if efb else max(0.0, min(1.0, self._volume))
        token = hashlib.sha1(("%s|%.2f|%.2f|%.3f" % (path, offset, duration, gain)).encode("utf-8")).hexdigest()[:12]
        try:
            target = path
            if offset > 0:
                target = _trim_wav(path, os.path.join(self.cache_dir, "trim-%s.wav" % token),
                                   offset, duration - offset)
            if gain < 0.999:
                target = _scale_wav(target, os.path.join(self.cache_dir, "play-%s.wav" % token), gain)
            if efb:
                self._handle = None
                self._efb_file = target
            else:
                self._handle = self._opener(target)
        except Exception as error:
            self._error = "The PC could not play the audio: %s" % error
            raise CabinError(self._error, 503)
        self._state = {"id": announcement, "slot": slot, "source": source, "path": path,
                       "started": time.time(), "position": round(offset, 2),
                       "duration": round(duration, 2), "paused": False,
                       "output": "efb" if efb else "xplane"}

    def set_volume(self, volume):
        try:
            value = max(0.0, min(1.0, float(volume)))
        except (TypeError, ValueError):
            raise CabinError("Volume must be between 0 and 1.")
        with self._lock:
            self._volume = value

    def control(self, action, volume=None):
        with self._lock:
            if action == "stop":
                self._finish_locked()
            elif action in ("pause", "resume"):
                playing = self._playing_locked(time.time())
                if playing:
                    position = self._position_locked(time.time())
                    path = self._state["path"]
                    if action == "pause":
                        if self._handle is not None:
                            self._handle.stop()
                            self._handle = None
                        self._state["position"] = position
                        self._state["paused"] = True
                    elif path and position < self._state["duration"] - 0.05:
                        self._start_locked(path, self._state["duration"], position,
                                           self._state["id"], self._state["slot"], self._state["source"],
                                           efb=self._state.get("output") == "efb")
            elif action == "volume":
                try:
                    value = max(0.0, min(1.0, float(volume)))
                except (TypeError, ValueError):
                    raise CabinError("Volume must be between 0 and 1.")
                changed = abs(value - self._volume) > 0.001
                self._volume = value
                # The gain is baked into the file being played, so an audible
                # change restarts it at the same word rather than silently
                # leaving the old level in place.
                if changed and self._state.get("output") != "efb":
                    position = self._position_locked(time.time())
                    if self._state["id"] and not self._state["paused"]:
                        self._start_locked(self._state["path"], self._state["duration"], position,
                                           self._state["id"], self._state["slot"], self._state["source"],
                                           efb=self._state.get("output") == "efb")
            else:
                raise CabinError("Unknown control action.")
            return self._snapshot_locked()
