"""Tests for the simulator bridge logic. Run: python3 -m unittest discover -s tests -p "test_*.py" """

import importlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TEMP = tempfile.mkdtemp(prefix="stratos-test-")
os.environ["STRATOS_DATA_DIR"] = TEMP

import bridge_logbook_addon as addon  # noqa: E402
importlib.reload(addon)

AIRPORTS = [
    ["KAAA", "Test Field", 37.0, -122.0, 30, [9, 27], [8000, 8000],
     [["09", "27", 37.0, -122.02, 37.0, -121.98, 8000, 150],
      ["27", "09", 37.0, -121.98, 37.0, -122.02, 8000, 150]],
     {"TWR": "118.0"}],
]


def telemetry(**overrides):
    data = {"lat": 37.0, "lon": -122.0, "alt": 30.0, "agl": 30.0, "gs": 0.0,
            "hdg": 90.0, "vs": 0.0, "src": "Test", "aircraft": "B738"}
    data.update(overrides)
    return data


def reset():
    addon.lb_save([])
    with addon._fs_lock:
        addon._flight_state.update(phase="PARKED", flight=None, parked_since=None, recent=[])
    for path in (addon.LOGBOOK_FILE, addon.INPROGRESS_FILE):
        try:
            os.remove(path)
        except OSError:
            pass


class LandingAnalysisTests(unittest.TestCase):
    def test_derived_vertical_speed(self):
        now = int(time.time() * 1000)
        samples = []
        for index in range(10):
            samples.append({"lat": 37.0, "lon": -122.01, "alt": 100 - index * 2,
                            "agl": 20, "gs": 130, "hdg": 90, "vs": -240,
                            "t": now - (9 - index) * 500})
        with addon._fs_lock:
            addon._flight_state["recent"] = samples
        result = addon._analyse_landing(telemetry(lat=37.0, lon=-122.01, alt=80, agl=0, gs=120, hdg=90), AIRPORTS)
        self.assertEqual(result["vsSource"], "derived from recorded altitude")
        self.assertLess(result["vsFpm"], 0)
        self.assertTrue(result["estimated"]["vs"] is False)

    def test_landing_rate_window_ends_at_first_wheel_contact(self):
        # 200 fpm descent until wheel contact at t=2000 ms, then a flat ground roll.
        # Using ground-roll samples flattens the slope (old bug: ~85 fpm instead of 200).
        base = 1_700_000_000_000
        samples = []
        for index in range(14):
            alt = 1000 - (200 / 60) * min(index, 8) * 0.25
            samples.append({"lat": 37.0, "lon": -122.01, "alt": alt, "agl": 0, "gs": 100,
                            "hdg": 90, "vs": -200, "t": base + index * 250})
        result = addon._analyse_landing(
            telemetry(lat=37.0, lon=-122.01, alt=1000, agl=0, gs=40, hdg=90), AIRPORTS,
            samples, touchdown_t=base + 2000)
        self.assertAlmostEqual(result["vsFpm"], -200, delta=1)

    def test_runway_match_and_distance(self):
        result = addon._analyse_landing(
            telemetry(lat=37.0002, lon=-122.01, alt=10, agl=0, gs=120, hdg=90), AIRPORTS)
        runway = result["runway"]
        self.assertIsNotNone(runway)
        self.assertEqual(runway["id"], "09/27")
        self.assertEqual(runway["lengthFt"], 8000)
        self.assertTrue(1000 < runway["distanceFromThresholdFt"] < 3000)
        self.assertTrue(runway["estimated"])
        self.assertTrue(result["estimated"]["runway"])

    def test_no_runway_when_far_away(self):
        result = addon._analyse_landing(
            telemetry(lat=38.0, lon=-121.0, alt=10, agl=0, gs=110, hdg=90), AIRPORTS)
        self.assertIsNone(result["runway"])
        self.assertTrue(any("Runway" in warning for warning in result["warnings"]))

    def test_classification_is_class_based(self):
        self.assertEqual(addon.classify_landing(-170, "B738")["key"], "good")
        self.assertEqual(addon.classify_landing(-170, "C172")["key"], "firm")
        self.assertEqual(addon.classify_landing(-600, "C172")["key"], "severe")
        self.assertEqual(addon.classify_landing(None, "C172")["key"], "unclassified")
        self.assertEqual(addon.classify_landing(-150, "")["classKey"], "unknown")

    def test_representative_touchdown_rates_use_fpm(self):
        # 100, 200 and 500 fpm, against the published per-class thresholds.
        # jet: smooth <=100, good <=180, firm <=300, hard <=600
        self.assertEqual(addon.classify_landing(-100, "B738")["key"], "smooth")
        self.assertEqual(addon.classify_landing(-200, "B738")["key"], "firm")
        self.assertEqual(addon.classify_landing(-500, "B738")["key"], "hard")
        # piston: smooth <=80, good <=140, firm <=220, hard <=400
        self.assertEqual(addon.classify_landing(-100, "C172")["key"], "good")
        self.assertEqual(addon.classify_landing(-200, "C172")["key"], "firm")
        self.assertEqual(addon.classify_landing(-500, "C172")["key"], "severe")
        # The rating reads the magnitude, so a positive sample is not a smooth landing.
        self.assertEqual(addon.classify_landing(500, "B738")["key"], "hard")


class FlightLifecycleTests(unittest.TestCase):
    def setUp(self):
        reset()

    def test_full_flight_records_track_and_landing(self):
        base = 1700000000000
        patcher = unittest.mock.patch.object(addon, "_now_ms", return_value=base)
        patcher.start()
        try:
            addon.process_telemetry_for_logbook(telemetry(), AIRPORTS)          # parked
            addon.process_telemetry_for_logbook(telemetry(gs=15), AIRPORTS)     # taxi
            self.assertEqual(addon.get_flight_phase(), "TAXI")
            addon.process_telemetry_for_logbook(telemetry(gs=150, agl=2000, alt=2000), AIRPORTS)
            self.assertEqual(addon.get_flight_phase(), "AIRBORNE")
            addon.process_telemetry_for_logbook(telemetry(lat=37.2, lon=-121.5, agl=4000, alt=12000, gs=300), AIRPORTS)
            with addon._fs_lock:
                flight = addon._flight_state["flight"]
                flight["takeoffTime"] = base - 3600 * 1000  # one hour airborne
            addon.process_telemetry_for_logbook(telemetry(lat=37.0002, lon=-122.01, agl=0, alt=15, gs=50, hdg=90, vs=-700), AIRPORTS)
            self.assertEqual(addon.get_flight_phase(), "LANDED")
            with addon._fs_lock:
                landing = addon._flight_state["flight"]["landing"]
            self.assertIsNotNone(landing)
            self.assertIsNotNone(landing["runway"])
            self.assertIn("classification", landing)
            with addon._fs_lock:
                addon._flight_state["parked_since"] = time.time() - addon.PARKED_SECONDS - 1
            addon.process_telemetry_for_logbook(telemetry(lat=37.0002, lon=-122.01, agl=0, alt=15, gs=0, hdg=90), AIRPORTS)
            flights = addon.lb_load()
            self.assertEqual(len(flights), 1)
            record = flights[0]
            self.assertTrue(record["complete"])
            self.assertFalse(record["incomplete"])
            self.assertGreater(len(record["track"]), 2)
            self.assertEqual(record["depAirport"], "KAAA")
            self.assertEqual(record["arrAirport"], "KAAA")
            self.assertIsNotNone(record["landing"]["runway"])
        finally:
            patcher.stop()

    def test_duplicate_records_are_ignored(self):
        flight = {"id": "flt_1", "complete": True, "takeoffTime": 1700000000000,
                  "depAirport": "KAAA", "arrAirport": "KBBB", "startTime": 1700000000000}
        self.assertTrue(addon.lb_add(dict(flight)))
        self.assertFalse(addon.lb_add(dict(flight)))
        twin = dict(flight, id="flt_2")
        self.assertFalse(addon.lb_add(twin))
        # A completed record upgrades an incomplete one.
        partial = {"id": "flt_3", "complete": False, "takeoffTime": 1700000000000,
                   "depAirport": "KAAA", "arrAirport": "KBBB"}
        addon.lb_save([partial])
        self.assertTrue(addon.lb_add(dict(flight, id="flt_3")))
        self.assertEqual(len(addon.lb_load()), 1)
        self.assertTrue(addon.lb_load()[0]["complete"])

    def test_shutdown_finalises_without_data_loss(self):
        with addon._fs_lock:
            addon._flight_state["flight"] = addon._new_flight(telemetry())
            addon._flight_state["flight"]["track"] = [
                {"lat": 37.0, "lon": -122.0, "alt": 100, "t": 1},
                {"lat": 37.1, "lon": -121.9, "alt": 200, "t": 2},
            ]
            addon._flight_state["phase"] = "AIRBORNE"
        saved = addon.finalize_active_flight("test shutdown")
        self.assertIsNotNone(saved)
        self.assertTrue(saved["incomplete"])
        flights = addon.lb_load()
        self.assertEqual(len(flights), 1)
        self.assertFalse(flights[0].get("recovered", False))
        self.assertEqual(flights[0]["track"][-1]["lat"], 37.1)

    def test_inprogress_recovery(self):
        flight = addon._new_flight(telemetry())
        flight["track"] = [{"lat": 37.0, "lon": -122.0, "alt": 10, "t": 1},
                           {"lat": 37.2, "lon": -121.8, "alt": 5000, "t": 2}]
        flight["takeoffTime"] = 1
        with open(addon.INPROGRESS_FILE, "w", encoding="utf-8") as handle:
            json.dump(flight, handle)
        recovered = addon.recover_inprogress()
        self.assertIsNotNone(recovered)
        self.assertTrue(recovered["incomplete"])
        flights = addon.lb_load()
        self.assertEqual(len(flights), 1)
        self.assertTrue(flights[0]["recovered"])
        self.assertFalse(os.path.exists(addon.INPROGRESS_FILE))

    def test_descent_gradient_is_measured_from_the_track(self):
        # 20 nm level at 18,000 ft, then 18,000 ft down to 1,800 ft over 60 nm
        # of straight track: 270 ft/nm.
        step = 1.0 / 60.0  # one nautical mile of latitude
        track = []
        for index in range(20):
            track.append({"lat": 37.0 + index * step, "lon": -122.0, "alt": 18000,
                          "t": index * 60000})
        for index in range(61):
            track.append({"lat": 39.0 + index * step, "lon": -122.0,
                          "alt": 18000 - index * 270, "t": (20 + index) * 60000})
        result = addon._analyse_descent(track)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result["ftPerNm"], 270.0, delta=2.0)
        self.assertEqual(result["startAltFt"], 18000)
        self.assertEqual(result["source"], "measured from the recorded track")

    def test_descent_is_ignored_when_the_track_is_unusable(self):
        self.assertIsNone(addon._analyse_descent([]))
        # Pattern work: a 1,000 ft drop is not a descent profile.
        short = [{"lat": 37.0 + i * 0.05, "lon": -122.0, "alt": 2000 - i * 200, "t": i} for i in range(6)]
        self.assertIsNone(addon._analyse_descent(short))
        # A descent with no distance is not a gradient either.
        stacked = [{"lat": 37.0, "lon": -122.0, "alt": 18000 - i * 1000, "t": i} for i in range(12)]
        self.assertIsNone(addon._analyse_descent(stacked))

    def test_descent_profile_uses_the_newest_measured_flight(self):
        addon.lb_save([
            {"id": "a", "complete": True, "endTime": 1000, "aircraft": "B738",
             "descent": {"ftPerNm": 250.0}},
            {"id": "b", "complete": True, "endTime": 2000, "aircraft": "B738",
             "descent": {"ftPerNm": 200.0}},
            {"id": "c", "complete": True, "endTime": 3000, "aircraft": "A320",
             "descent": {"ftPerNm": 9999.0}},
        ])
        profile = addon.get_descent_profile()
        self.assertTrue(profile["available"])
        self.assertEqual(profile["ftPerNm"], 200.0)
        self.assertEqual(profile["medianFtPerNm"], 225.0)
        self.assertEqual(profile["flights"], 2)

    def test_descent_profile_is_unavailable_before_any_flight(self):
        addon.lb_save([])
        profile = addon.get_descent_profile()
        self.assertFalse(profile["available"])
        self.assertEqual(profile["flights"], 0)

    def test_current_flight_summary_carries_a_sampled_track(self):
        addon.process_telemetry_for_logbook(telemetry(gs=20), AIRPORTS)
        summary = addon.get_current_flight()
        self.assertIn("phase", summary)
        self.assertEqual(summary["phase"], "TAXI")
        # The live payload carries the recorded path, sampled, so a page opened
        # halfway through can draw the flight from its first point.
        self.assertIsInstance(summary["track"], list)
        self.assertLessEqual(len(summary["track"]), addon.TRACK_STREAM_POINTS + 1)

    def test_stats_counts_only_complete_flights(self):
        addon.lb_save([
            {"id": "a", "complete": True, "incomplete": False, "takeoffTime": 0, "landingTime": 3600000,
             "distanceNm": 100, "landing": {"vsFpm": -120}},
            {"id": "b", "complete": True, "incomplete": True, "takeoffTime": 0, "landingTime": 3600000},
            {"id": "c", "complete": False},
        ])
        stats = addon.get_stats()
        self.assertEqual(stats["flights"], 1)
        self.assertEqual(stats["incomplete"], 2)
        self.assertEqual(stats["hours"], 1.0)
        self.assertEqual(stats["landings"], 1)


import unittest.mock  # noqa: E402  (imported after env setup for clarity)
import stratos_bridge as bridge  # noqa: E402


class PairLandingTests(unittest.TestCase):
    """One-tap pairing lands on the page the phone asked for, and only on this bridge."""

    @staticmethod
    def handler(path):
        instance = bridge.Handler.__new__(bridge.Handler)
        instance.path = path
        return instance

    def test_a_phone_lands_on_the_live_dashboard_by_default(self):
        self.assertEqual(self.handler("/pair/connect").pair_landing(), "/live.html")

    def test_a_phone_can_ask_for_the_map_instead(self):
        self.assertEqual(self.handler("/pair/connect?next=%2Findex.html").pair_landing(), "/index.html")

    def test_the_landing_page_cannot_be_sent_off_this_bridge(self):
        for bad in ("/pair/connect?next=https://example.com",
                    "/pair/connect?next=//example.com",
                    "/pair/connect?next=/../bridge_token.txt",
                    "/pair/connect?next=index.html"):
            self.assertEqual(self.handler(bad).pair_landing(), "/live.html", bad)


class PairingTests(unittest.TestCase):
    def setUp(self):
        bridge.revoke_pairs()
        with bridge.PAIR_LOCK:
            bridge.PAIR_ATTEMPTS.clear()
            bridge.PAIR_CLIENTS.clear()
        try:
            os.unlink(bridge.PHONE_PAIRS_FILE)
        except OSError:
            pass

    def test_a_new_pairing_is_short_lived_and_single_use(self):
        session = bridge.create_pair_session()
        self.assertIn("/pair?t=", session["url"])
        self.assertRegex(session["code"], r"^\d{6}$")
        self.assertEqual(session["ttlSeconds"], 120)
        self.assertGreater(session["expiresAt"], time.time() * 1000)
        self.assertTrue(bridge.claim_pair(session["token"]))
        self.assertFalse(bridge.claim_pair(session["token"]), "a pairing token must work once")

    def test_the_six_digit_code_pairs_once(self):
        session = bridge.create_pair_session()
        self.assertTrue(bridge.claim_pair(session["code"]))
        self.assertFalse(bridge.claim_pair(session["code"]))

    def test_unknown_or_empty_values_never_pair(self):
        bridge.create_pair_session()
        self.assertFalse(bridge.claim_pair(""))
        self.assertFalse(bridge.claim_pair("000000-not-a-code"))
        self.assertFalse(bridge.claim_pair(None))

    def test_an_expired_pairing_is_rejected_and_cleaned_up(self):
        session = bridge.create_pair_session()
        with bridge.PAIR_LOCK:
            for entry in bridge.PAIR_SESSIONS.values():
                entry["expires"] = time.time() - 1
        self.assertFalse(bridge.claim_pair(session["token"]))
        bridge.pair_clean()
        with bridge.PAIR_LOCK:
            self.assertEqual(bridge.PAIR_SESSIONS, {})

    def test_status_never_exposes_the_token(self):
        bridge.create_pair_session()
        status = bridge.pair_status()
        self.assertEqual(status["activeCodes"], 1)
        self.assertNotIn("token", json.dumps(status).lower())

    def test_a_paired_phone_gets_its_own_secret_and_only_a_hash_is_stored(self):
        secret, record = bridge.pair_client("10.0.0.9")
        self.assertTrue(bridge.verify_phone_secret(secret))
        self.assertFalse(bridge.verify_phone_secret("not-the-secret"))
        self.assertFalse(bridge.verify_phone_secret(""))
        self.assertTrue(record["id"])
        status = bridge.pair_status()
        self.assertEqual(status["clients"], 1)
        self.assertEqual(status["devices"][0]["label"], "10.0.0.9")
        serialized = json.dumps(status)
        self.assertNotIn(secret, serialized)
        with open(bridge.PHONE_PAIRS_FILE, "r", encoding="utf-8") as handle:
            stored = handle.read()
        self.assertNotIn(secret, stored)
        self.assertIn(bridge.phone_digest(secret), stored)

    def test_phone_pairing_survives_a_bridge_restart(self):
        secret, record = bridge.pair_client("10.0.0.10")
        with bridge.PAIR_LOCK:
            bridge.PAIR_CLIENTS.clear()
        self.assertFalse(bridge.verify_phone_secret(secret))
        bridge.load_phone_clients()
        self.assertTrue(bridge.verify_phone_secret(secret))
        self.assertEqual(bridge.pair_status()["devices"][0]["id"], record["id"])

    def test_forgetting_one_phone_keeps_the_other_paired(self):
        first, first_record = bridge.pair_client("10.0.0.11")
        second, _ = bridge.pair_client("10.0.0.12")
        self.assertTrue(bridge.revoke_phone_client(first_record["id"]))
        self.assertFalse(bridge.verify_phone_secret(first))
        self.assertTrue(bridge.verify_phone_secret(second))
        self.assertEqual(bridge.pair_status()["clients"], 1)
        self.assertFalse(bridge.revoke_phone_client(first_record["id"]), "revoking twice is harmless")

    def test_a_phone_can_forget_itself(self):
        secret, _ = bridge.pair_client("10.0.0.13")
        self.assertTrue(bridge.revoke_phone_client_for_secret(secret))
        self.assertFalse(bridge.verify_phone_secret(secret))
        self.assertFalse(bridge.revoke_phone_client_for_secret(secret))

    def test_forgetting_every_phone_invalidates_old_secrets_and_rotates_the_shared_token(self):
        secret, _ = bridge.pair_client("10.0.0.14")
        before = bridge.TOKEN
        bridge.revoke_pairs()
        self.assertFalse(bridge.verify_phone_secret(secret))
        self.assertEqual(bridge.pair_status()["clients"], 0)
        self.assertNotEqual(bridge.TOKEN, before)
        with open(bridge.TOKEN_FILE, "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read().strip(), bridge.TOKEN)


class ChecklistSyncTests(unittest.TestCase):
    def setUp(self):
        with bridge.CHECKLIST_LOCK:
            bridge.CHECKLIST_STATE.clear()

    def test_state_is_sanitised_before_it_is_shared(self):
        saved = bridge.save_checklist({
            "profileKey": "a346-toliss",
            "flightKey": "flight:1",
            "activeSection": "beforeStart",
            "revision": 4,
            "checks": {"beforeStart.0": True, "beforeStart.1": False, "beforeStart.2": "yes",
                       "x" * 200: True},
        })
        self.assertEqual(saved["checks"], {"beforeStart.0": True})
        self.assertEqual(saved["flightKey"], "flight:1")
        self.assertEqual(saved["revision"], 4)

    def test_an_older_revision_cannot_overwrite_a_newer_one(self):
        bridge.save_checklist({"flightKey": "flight:1", "revision": 5, "checks": {"a.0": True}})
        result = bridge.save_checklist({"flightKey": "flight:1", "revision": 3, "checks": {"b.0": True}})
        self.assertEqual(result["revision"], 5)
        self.assertIn("a.0", result["checks"])
        self.assertNotIn("b.0", result["checks"])

    def test_a_new_flight_replaces_the_previous_state(self):
        bridge.save_checklist({"flightKey": "flight:1", "revision": 9, "checks": {"a.0": True}})
        bridge.save_checklist({"flightKey": "flight:2", "revision": 0, "checks": {}})
        snapshot = bridge.checklist_snapshot()
        self.assertEqual(snapshot["flightKey"], "flight:2")
        self.assertEqual(snapshot["checks"], {})

    def test_snapshots_are_copies(self):
        bridge.save_checklist({"flightKey": "flight:1", "revision": 1, "checks": {"a.0": True}})
        snapshot = bridge.checklist_snapshot()
        snapshot["checks"]["b.0"] = True
        self.assertEqual(bridge.checklist_snapshot()["checks"], {"a.0": True})

    def test_empty_or_malformed_payloads_are_ignored(self):
        self.assertIsNone(bridge.save_checklist("nope"))
        self.assertIsNone(bridge.save_checklist([1, 2, 3]))
        self.assertIsNone(bridge.checklist_snapshot())


class PhoneDiscoveryTests(unittest.TestCase):
    """The one-tap connection: mDNS name, LAN-only enrollment, RREF identity."""

    def test_a_query_for_our_name_is_answered_with_the_lan_address(self):
        query = (b"\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00"
                 + bridge.dns_encode_name("stratos.local") + b"\x00\x01\x00\x01")
        self.assertEqual(bridge.dns_questions(query), [("stratos.local", 1)])
        reply = bridge.mdns_response(query, "192.168.1.20")
        self.assertIsNotNone(reply)
        self.assertEqual(reply[2] & 0x80, 0x80, "the reply is a response")
        self.assertIn(b"\xc0\xa8\x01\x14", reply, "the A record carries the LAN address")

    def test_a_query_for_another_name_is_left_alone(self):
        query = (b"\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00"
                 + bridge.dns_encode_name("printer.local") + b"\x00\x01\x00\x01")
        self.assertIsNone(bridge.mdns_response(query, "192.168.1.20"))

    def test_the_service_is_advertised_without_a_secret(self):
        txt = bridge.mdns_txt()
        self.assertIn(b"path=/live", txt)
        self.assertNotIn(b"token", txt.lower())
        self.assertTrue(bridge.mdns_txt().startswith(bytes([len(b"path=/live")])))

    def test_auto_pairing_is_limited_to_the_local_network(self):
        self.assertTrue(bridge.is_lan_address("192.168.1.5"))
        self.assertTrue(bridge.is_lan_address("10.0.0.4"))
        self.assertFalse(bridge.is_lan_address("8.8.8.8"))
        self.assertFalse(bridge.is_lan_address("203.0.113.9"))

    def test_auto_pairing_says_why_it_cannot_run(self):
        original_host, original_enabled = bridge.HOST, bridge.AUTO_PAIR_ENABLED
        try:
            bridge.HOST = "127.0.0.1"
            self.assertIn("only on this PC", bridge.auto_pair_gate("192.168.1.5"))
            bridge.HOST = "0.0.0.0"
            self.assertIn("local network", bridge.auto_pair_gate("203.0.113.9"))
            bridge.AUTO_PAIR_ENABLED = False
            self.assertIn("turned off", bridge.auto_pair_gate("192.168.1.5"))
            bridge.AUTO_PAIR_ENABLED = True
            self.assertEqual(bridge.auto_pair_gate("192.168.1.5"), "")
        finally:
            bridge.HOST, bridge.AUTO_PAIR_ENABLED = original_host, original_enabled

    def test_auto_pairing_hands_out_its_own_secret(self):
        original_host = bridge.HOST
        try:
            bridge.HOST = "0.0.0.0"
            secret, record = bridge.auto_pair("192.168.1.5")
            self.assertTrue(secret)
            self.assertTrue(bridge.verify_phone_secret(secret))
            self.assertEqual(record["pairedAt"] > 0, True)
        finally:
            bridge.HOST = original_host


class XPlaneIdentityTests(unittest.TestCase):
    def test_a_request_is_the_standard_rref_packet(self):
        packet = bridge.rref_request(9003, "sim/aircraft/view/acf_tailnum[3]", 1)
        self.assertEqual(packet[:4], b"RREF")
        self.assertEqual(len(packet), 5 + 4 + 4 + 400)
        self.assertEqual(bridge.struct.unpack("<i", packet[5:9])[0], 1)
        self.assertEqual(bridge.struct.unpack("<i", packet[9:13])[0], 9003)
        self.assertEqual(packet[13:13 + 34].rstrip(b"\x00"),
                         b"sim/aircraft/view/acf_tailnum[3]")

    def test_several_values_may_share_one_packet(self):
        body = b"RREF\x00" + bridge.struct.pack("<if", 9000, 67.0) + bridge.struct.pack("<if", 9001, 45.0)
        self.assertEqual(bridge.rref_values(body), [(9000, 67.0), (9001, 45.0)])
        self.assertEqual(bridge.rref_values(b"DATA\x00"), [])

    def test_characters_assemble_into_the_reported_text(self):
        chars = {0: 78.0, 1: 56.0, 2: 51.0, 3: 49.0, 4: 50.0, 5: 67.0}
        self.assertEqual(bridge.rref_text(chars), "N8312C")
        self.assertEqual(bridge.rref_text({0: 78.0, 1: 0.0, 2: 56.0}), "N")
        self.assertEqual(bridge.rref_text({1: 56.0, 2: 51.0}), "")

    def test_placeholders_are_not_registrations(self):
        for value in ("", "NONE", "N/A", "B738", "---"):
            self.assertEqual(bridge.plausible_registration(value), "")
        self.assertEqual(bridge.plausible_registration("n8312c"), "N8312C")
        self.assertEqual(bridge.plausible_registration("G-TAWI"), "G-TAWI")
        self.assertEqual(bridge.plausible_registration("B-1234"), "B-1234", "a country mark is not a type")
        self.assertEqual(bridge.plausible_registration("MD-82"), "", "a type with a hyphen is still a type")

    def test_the_subscription_covers_every_character_and_numeric_row(self):
        self.assertEqual(len(bridge.RREF_REQUESTS), 10 + 8 + 48 + 3)
        names = [dataref for _index, dataref in bridge.RREF_REQUESTS]
        self.assertIn("sim/aircraft/view/acf_tailnum[0]", names)
        self.assertIn("sim/aircraft/view/acf_tailnum[9]", names)
        self.assertIn("sim/weather/region/altimeter_setting_inhg", names)
        self.assertIn("sim/flightmodel/weight/m_total", names)
        self.assertIn("sim/cockpit2/controls/flap_ratio", names)

    def test_performance_datarefs_become_physical_values(self):
        saved = dict(bridge._XPLANE_NUMERIC)
        saved_status = dict(bridge.xplane_performance_status)
        try:
            bridge._XPLANE_NUMERIC.update(qnh=29.92, weight=70000.0, flap=0.5)
            bridge.apply_xplane_performance()
            status = bridge.xplane_performance_status
            self.assertTrue(status["available"])
            self.assertAlmostEqual(status["qnhHpa"], 1013.2, places=1)
            self.assertEqual(status["weightKg"], 70000.0)
            self.assertEqual(status["flapRatio"], 0.5)
            self.assertGreater(status["at"], 0)
        finally:
            bridge._XPLANE_NUMERIC.clear()
            bridge._XPLANE_NUMERIC.update(saved)
            bridge.xplane_performance_status.clear()
            bridge.xplane_performance_status.update(saved_status)

    def test_implausible_performance_values_are_not_published(self):
        saved = dict(bridge._XPLANE_NUMERIC)
        saved_status = dict(bridge.xplane_performance_status)
        try:
            bridge.xplane_performance_status.update(
                available=False, qnhHpa=None, weightKg=None, flapRatio=None, at=0)
            bridge._XPLANE_NUMERIC.update(qnh=0.0, weight=0.0, flap=1.5)
            bridge.apply_xplane_performance()
            self.assertFalse(bridge.xplane_performance_status["available"])
            self.assertIsNone(bridge.xplane_performance_status["qnhHpa"])
        finally:
            bridge._XPLANE_NUMERIC.clear()
            bridge._XPLANE_NUMERIC.update(saved)
            bridge.xplane_performance_status.clear()
            bridge.xplane_performance_status.update(saved_status)


class RelayTrafficTests(unittest.TestCase):
    """What a relayed phone gets: the list, and only the samples it lacks."""

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="stratos-relay-traffic-")
        self.file = bridge.TRAFFIC_FILE
        bridge.TRAFFIC_FILE = os.path.join(self.directory, "traffic_trails.json")
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        with bridge.state_lock:
            self.saved_tr = bridge.state.get("tr")
            self.saved_trt = bridge.state.get("trt")

    def tearDown(self):
        bridge.TRAFFIC_FILE = self.file
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        with bridge.state_lock:
            if self.saved_tr is None:
                bridge.state.pop("tr", None)
            else:
                bridge.state["tr"] = self.saved_tr
            if self.saved_trt is None:
                bridge.state.pop("trt", None)
            else:
                bridge.state["trt"] = self.saved_trt

    def test_the_batch_carries_the_list_and_every_new_sample(self):
        now = int(time.time() * 1000)
        with bridge.state_lock:
            bridge.state["tr"] = [
                {"id": "SWR219", "lat": 46.5, "lon": -122.9, "alt": 12000, "gs": 320, "hdg": 180},
                {"id": "", "lat": 46.0, "lon": -122.0},
                {"id": "BAD", "lat": None, "lon": None},
            ]
            bridge.state["trt"] = time.time()
        bridge.record_traffic([
            ["SWR219", 46.5, -122.9, 12000, now - 15000],
            ["SWR219", 46.4, -122.8, 16000, now],
            ["DLH400", 47.0, -121.0, 30000, now],
        ])
        batch = bridge.relay_traffic_batch({})
        self.assertEqual([entry["id"] for entry in batch["list"]], ["SWR219"],
                         "an entry without a usable position is not relayed")
        self.assertEqual(batch["list"][0]["alt"], 12000)
        keys = {point[0] for point in batch["points"]}
        self.assertEqual(keys, {"SWR219", "DLH400"})
        self.assertEqual([point[3] for point in batch["points"] if point[0] == "SWR219"], [12000, 16000],
                         "a trail keeps the altitudes it recorded")

    def test_only_samples_after_the_cursor_are_sent_again(self):
        now = int(time.time() * 1000)
        bridge.record_traffic([
            ["SWR219", 46.5, -122.9, 12000, now - 15000],
            ["SWR219", 46.4, -122.8, 16000, now],
        ])
        first = bridge.relay_traffic_batch({})
        cursor = {}
        for key, _lat, _lon, _alt, stamp in first["points"]:
            cursor[key] = max(cursor.get(key, 0), stamp)
        self.assertEqual(bridge.relay_traffic_batch(cursor)["points"], [],
                         "nothing new means nothing sent")
        # record_traffic never accepts a stamp in the future, so the sample has to
        # arrive after the one already stored or it would collapse onto its
        # millisecond and count as nothing new.
        time.sleep(0.02)
        bridge.record_traffic([["SWR219", 46.3, -122.7, 20000, now + 5000]])
        second = bridge.relay_traffic_batch(cursor)
        self.assertEqual([point[0] for point in second["points"]], ["SWR219"])
        self.assertEqual(second["points"][0][3], 20000)

    def test_the_batch_is_bounded(self):
        now = int(time.time() * 1000)
        with bridge.state_lock:
            bridge.state["tr"] = [{"id": "A%d" % index, "lat": 40.0 + index / 100, "lon": 8.0, "alt": 1000}
                                  for index in range(80)]
            bridge.state["trt"] = time.time()
        bridge.record_traffic([["A%d" % index, 40.0, 8.0, 1000, now] for index in range(40)])
        batch = bridge.relay_traffic_batch({})
        self.assertLessEqual(len(batch["list"]), 60)
        self.assertLessEqual(len(batch["points"]), bridge.TRAFFIC_RELAY_MAX_POINTS)


class StreamTrackTests(unittest.TestCase):
    def test_the_stream_carries_the_whole_flight_evenly_sampled(self):
        track = [{"lat": 37.0 + i * 0.001, "lon": -122.0, "alt": 1000 + i, "t": i}
                 for i in range(2000)]
        points = addon.stream_track(track)
        self.assertLessEqual(len(points), addon.TRACK_STREAM_POINTS + 1)
        self.assertEqual(points[0][0], 37.0, "the first point is kept")
        self.assertEqual(points[-1][0], track[-1]["lat"], "the last point is kept")
        # Chronological, and no invented positions.
        self.assertEqual(points, sorted(points, key=lambda point: point[3]))
        self.assertTrue(all(len(point) == 5 for point in points))
        self.assertTrue(all(point[4] is None for point in points), "a sample without AGL says so instead of inventing one")

    def test_a_short_track_is_passed_through_unchanged(self):
        track = [{"lat": 1.0, "lon": 2.0, "alt": 3.0, "t": 4}, {"lat": 5.0, "lon": 6.0, "alt": 7.0, "t": 8}]
        self.assertEqual(addon.stream_track(track), [[1.0, 2.0, 3.0, 4, None], [5.0, 6.0, 7.0, 8, None]])
        self.assertEqual(addon.stream_track([]), [])

    def test_the_stream_carries_the_height_above_ground_when_the_sim_gave_it(self):
        track = [
            {"lat": 1.0, "lon": 2.0, "alt": 5500.0, "t": 1004, "agl": 0.0},
            {"lat": 5.0, "lon": 6.0, "alt": 9500.0, "t": 1008, "agl": 4000.0},
        ]
        self.assertEqual(addon.stream_track(track), [[1.0, 2.0, 5500.0, 1004, 0.0], [5.0, 6.0, 9500.0, 1008, 4000.0]])


class TrafficTrailTests(unittest.TestCase):
    """The bridge remembers the traffic the page has seen, so a trail survives."""

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="stratos-trails-")
        self.file = bridge.TRAFFIC_FILE
        self.retention = bridge.TRAFFIC_RETENTION_S
        bridge.TRAFFIC_FILE = os.path.join(self.directory, "traffic_trails.json")
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        bridge.TRAFFIC_SAVE.update(at=0.0, dirty=False)

    def tearDown(self):
        bridge.TRAFFIC_FILE = self.file
        bridge.TRAFFIC_RETENTION_S = self.retention
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        bridge.TRAFFIC_SAVE.update(at=0.0, dirty=False)

    def test_positions_are_recorded_once_each_and_in_order(self):
        now = int(time.time() * 1000)
        added = bridge.record_traffic([
            ["4ca1b2", 47.1, -122.3, 12000, now - 2000],
            ["4CA1B2", 47.1, -122.3, 12000, now - 2000],  # the same sample again
            ["4CA1B2", 47.2, -122.2, 18000, now],
        ])
        self.assertEqual(added, 2, "a repeated position is not a second sample")
        points = bridge.traffic_trail("4CA1B2")
        self.assertEqual([point[0] for point in points], [47.1, 47.2])
        self.assertEqual(points, sorted(points, key=lambda point: point[3]), "chronological")
        self.assertEqual(bridge.traffic_trail("4ca1b2")[0][2], 12000, "the key is normalised")

    def test_a_sample_that_arrives_late_does_not_rewind_the_path(self):
        now = int(time.time() * 1000)
        bridge.record_traffic([["ABC123", 47.0, -122.0, 10000, now]])
        bridge.record_traffic([["ABC123", 46.0, -121.0, 9000, now - 60000]])
        points = bridge.traffic_trail("ABC123")
        self.assertEqual(len(points), 1, "a stale sample is dropped, not appended at the end")
        self.assertEqual(points[0][0], 47.0)

    def test_a_position_of_zero_zero_is_not_a_position(self):
        added = bridge.record_traffic([["ABC123", 0, 0, 0, int(time.time() * 1000)],
                                       ["ABC123", 200, 10, 0, int(time.time() * 1000)],
                                       ["", 47.0, -122.0, 0, int(time.time() * 1000)]])
        self.assertEqual(added, 0)
        self.assertEqual(bridge.traffic_trail("ABC123"), [])

    def test_the_trail_is_on_disk_and_survives_a_restart(self):
        bridge.record_traffic([["DEF456", 45.0, 9.0, 30000, int(time.time() * 1000)]])
        self.assertTrue(os.path.isfile(bridge.TRAFFIC_FILE), "the trail is written to the data folder")
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        bridge.load_traffic_trails()
        points = bridge.traffic_trail("DEF456")
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0][2], 30000)

    def test_the_retention_window_drops_an_old_trail(self):
        bridge.TRAFFIC_RETENTION_S = 60
        now = int(time.time() * 1000)
        bridge.record_traffic([["OLD999", 40.0, 8.0, 20000, now - 120000]])
        self.assertEqual(bridge.traffic_trail("OLD999"), [], "a sample past the window is not served")

    def test_the_per_aircraft_cap_keeps_the_newest_samples(self):
        now = int(time.time() * 1000)
        points = [["CAP123", 40.0 + index * 0.01, 8.0, 30000, now + index] for index in range(bridge.TRAFFIC_MAX_POINTS + 40)]
        bridge.record_traffic(points)
        trail = bridge.traffic_trail("CAP123")
        self.assertEqual(len(trail), bridge.TRAFFIC_MAX_POINTS)
        self.assertEqual(trail[-1][0], points[-1][1], "the newest sample is kept")


class AircraftPhotoTests(unittest.TestCase):
    """The bridge serves photos for the pages it hosts, so the card works there."""

    def test_only_a_registration_reaches_the_photo_service(self):
        self.assertEqual(bridge.photo_registration(" n8312c "), "N8312C")
        self.assertEqual(bridge.photo_registration("9V-SKA"), "9V-SKA")
        self.assertEqual(bridge.photo_registration("B-1234"), "B-1234")
        self.assertEqual(bridge.photo_registration("12345"), "", "a number is not a registration")
        self.assertEqual(bridge.photo_registration("ASA123"), "", "a callsign is not a registration")
        self.assertEqual(bridge.photo_registration("B738"), "", "a type code is not a registration")
        self.assertEqual(bridge.photo_registration(""), "")
        self.assertEqual(bridge.photo_registration(None), "")
        self.assertEqual(bridge.photo_registration("N<script>"), "")

    def test_an_n_number_that_looks_like_a_type_is_still_a_tail(self):
        for reg in ("N123", "N1234", "N737SW", "N8312C"):
            self.assertEqual(bridge.photo_registration(reg), reg)

    def test_a_mode_s_address_is_six_hex_digits(self):
        self.assertEqual(bridge.photo_hex(" ab5eb2 "), "AB5EB2")
        for value in ("", None, "4066D", "4066D0A", "ZZZZZZ", "BAW2620"):
            self.assertEqual(bridge.photo_hex(value), "", str(value))

    def test_a_found_photo_is_kept_longer_than_a_miss(self):
        self.assertGreater(bridge.PHOTO_TTL, bridge.PHOTO_MISS_TTL)
        self.assertGreaterEqual(bridge.PHOTO_MISS_TTL, 60, "a miss is cached too, so the card does not spam")


if __name__ == "__main__":
    unittest.main(verbosity=2)
