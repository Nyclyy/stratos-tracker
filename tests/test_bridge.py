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

    def test_current_flight_summary_has_no_track(self):
        addon.process_telemetry_for_logbook(telemetry(gs=20), AIRPORTS)
        summary = addon.get_current_flight()
        self.assertIn("phase", summary)
        self.assertNotIn("track", summary)
        self.assertEqual(summary["phase"], "TAXI")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
