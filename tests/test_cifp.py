"""Tests for the X-Plane CIFP reader.

The fixture is written in the same format X-Plane 12 uses, with invented
identifiers and coordinates. No licensed navigation data is committed: the
parser is exercised on the format, and the real files are only ever read on the
pilot's own machine.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

import stratos_cifp as cifp


def procedure_row(kind, sequence, procedure, transition, fix, region="K1", section="E", terminator="TF"):
    fields = ["4", procedure, transition, fix, region, section, "A", "E   ", " ", "   ", terminator,
              " ", " ", " ", " ", " ", "      ", "    ", "    ", "    ", "    ",
              " ", "     ", "     ", "     ", " ", "   ", "    ", "   ",
              " ", " ", " ", " ", " ", " ", " ", " ", " "]
    return "%s:%03d,%s ;" % (kind, sequence, ",".join(fields))


CIFP = "\r\n".join([
    # A SID with a heading leg from the runway, then fixes and a VOR.
    procedure_row("SID", 10, "TEST1", "RW16L", " ", terminator="CA"),
    procedure_row("SID", 20, "TEST1", "RW16L", "CAVOB", section="P", terminator="DF"),
    procedure_row("SID", 30, "TEST1", "RW16L", "RENBE"),
    procedure_row("SID", 40, "TEST1", "RW16L", "BTG", section="D"),
    procedure_row("SID", 50, "TEST1", "RW16L", "BANGR"),
    # A second runway transition.
    procedure_row("SID", 10, "TEST1", "RW34R", "DODVE"),
    # An en-route transition with one fix the data does not carry.
    procedure_row("SID", 10, "TEST1", "ARRIE", "BANGR", terminator="IF"),
    procedure_row("SID", 20, "TEST1", "ARRIE", "ARRIE"),
    procedure_row("SID", 30, "TEST1", "ARRIE", "GHOST"),
    # A STAR that ends at the airport itself (expect vectors).
    procedure_row("STAR", 10, "TEST2", "RW28B", "RADDY", terminator="IF"),
    procedure_row("STAR", 20, "TEST2", "RW28B", "KSEA", section="P", terminator="VM"),
    procedure_row("STAR", 10, "TEST2", "PDT", "CHINS", terminator="IF"),
    # Runway thresholds in the file's own DMS form.
    "RWY:RW16L,     ,      ,00432, ,ISNQ,3,   ;N47274966,W122182790,0000;",
    "RWY:RW34R,     ,      ,00347, ,ISEA,3,   ;N47255222,W122182894,0000;",
    "RWY:RW28B,     ,      ,00031, ,IPDX,3,   ;N45350300,W122340000,0000;",
])

FIXES = "\r\n".join([
    "I",
    "1200 Version - test fixture, not navigation data",
    " 47.396192000 -122.308347000  CAVOB KSEA K1 1 CAVOB",
    " 47.320364000 -122.311544000  RENBE KSEA K1 2 RENBE",
    " 47.643903000 -122.914914000  BANGR ENRT K1 3 BANGR",
    " 47.879892000 -123.475833000  ARRIE ENRT K1 4 ARRIE",
    " 47.400000000 -122.500000000  RADDY ENRT K1 5 RADDY",
    " 45.900000000 -119.500000000  CHINS ENRT K1 6 CHINS",
    " 47.498775000 -122.307444000  DODVE ENRT K1 7 DODVE",
])

NAVAIDS = "\r\n".join([
    "I",
    "1200 Version - test fixture",
    " 3  45.747811111 -122.591536111      253    11660   130     21.000  BTG ENRT K1 BATTLE GROUND VORTAC",
    "12  45.747672222 -122.592294444      253    11660   130      0.000  BTG ENRT K1 BATTLE GROUND VORTAC DME",
])

AIRPORTS = "\r\n".join([
    "I",
    "1210 Version - test fixture",
    "KSEA K1  47.449888889 -122.311777778   432 C 11900 I 18000 FL180",
])

CYCLE = "AIRAC cycle    : 2610\r\n"


def make_install(root):
    custom = Path(root) / "Custom Data"
    (custom / "CIFP").mkdir(parents=True, exist_ok=True)
    (custom / "CIFP" / "KSEA.dat").write_text(CIFP, encoding="utf-8")
    (custom / "earth_fix.dat").write_text(FIXES, encoding="utf-8")
    (custom / "earth_nav.dat").write_text(NAVAIDS, encoding="utf-8")
    (custom / "earth_aptmeta.dat").write_text(AIRPORTS, encoding="utf-8")
    (custom / "cycle_info.txt").write_text(CYCLE, encoding="utf-8")
    return str(root)


class CifpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.install = make_install(cls.tmp.name)
        cls.nav = cifp.NavData(cls.install)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_install_is_found_from_an_explicit_path(self):
        self.assertEqual(cifp.find_xplane_dir(self.install), os.path.normpath(self.install))
        self.assertEqual(cifp.read_cycle(self.install)["cycle"], "2610")

    def test_runway_thresholds_are_read_from_the_dms_records(self):
        payload = self.nav.procedures("KSEA")
        self.assertEqual(payload["runways"]["16L"]["lat"], 47.463794)
        self.assertAlmostEqual(payload["runways"]["16L"]["lon"], -122.30775, places=6)
        self.assertAlmostEqual(payload["runways"]["34R"]["lat"], 47.431172, places=6)
        self.assertEqual(payload["cycle"], "2610")

    def test_a_sid_keeps_its_fixes_in_order_and_resolves_a_vor(self):
        payload = self.nav.procedures("KSEA", "sid", "TEST1")
        transitions = {t["id"]: t for t in payload["procedures"]["sid"][0]["transitions"]}
        self.assertIn("RW16L", transitions)
        points = transitions["RW16L"]["points"]
        self.assertEqual([p["id"] for p in points], ["CAVOB", "RENBE", "BTG", "BANGR"])
        self.assertEqual(points[2]["lat"], 45.747811, "the VOR is resolved from earth_nav.dat")
        self.assertTrue(transitions["RW16L"]["complete"])
        self.assertEqual(points[0]["terminator"], "DF")

    def test_an_unresolved_fix_is_counted_and_never_invented(self):
        payload = self.nav.procedures("KSEA", "sid", "TEST1")
        transitions = {t["id"]: t for t in payload["procedures"]["sid"][0]["transitions"]}
        arrie = transitions["ARRIE"]
        self.assertEqual([p["id"] for p in arrie["points"]], ["BANGR", "ARRIE"])
        self.assertEqual(arrie["skipped"], 1)
        self.assertFalse(arrie["complete"])
        self.assertNotIn("GHOST", [p["id"] for p in arrie["points"]], "an unknown fix is not placed")

    def test_a_star_transition_names_its_combined_runways(self):
        payload = self.nav.procedures("KSEA", "star", "TEST2")
        transitions = {t["id"]: t for t in payload["procedures"]["star"][0]["transitions"]}
        combined = transitions["RW28B"]
        self.assertTrue(combined["combined"])
        self.assertEqual(combined["runway"], "28")
        self.assertEqual([p["id"] for p in combined["points"]], ["RADDY", "KSEA"],
                         "the airport point comes from earth_aptmeta.dat")
        self.assertTrue(combined["complete"])

    def test_missing_airport_procedure_and_data_are_reported(self):
        self.assertEqual(self.nav.procedures("KSEA", "sid", "NOPE")["reason"], "not-found")
        self.assertEqual(self.nav.procedures("KS")["reason"], "bad-request")
        empty = cifp.NavData(str(Path(self.tmp.name) / "nothing-here"), dataset_dir="")
        self.assertFalse(empty.available)
        self.assertEqual(empty.procedures("KSEA")["reason"], "no-navdata")

    def test_the_shipped_dataset_answers_when_the_simulator_has_nothing(self):
        dataset = cifp.NavData(str(Path(self.tmp.name) / "nothing-here"))
        payload = dataset.procedures("KSEA", "sid", "BANGR9")
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["source"].startswith("FAA CIFP"))
        self.assertEqual(payload["cycle"], dataset.dataset.summary()["cycle"])

    def test_a_runway_leg_uses_the_threshold_record(self):
        # RW16L's first published fix is a "P" section point; the runway itself
        # is not a fix, so the threshold is the only coordinate that exists.
        self.assertEqual(cifp._runway_of("RW16L"), "16L")
        self.assertEqual(cifp._runway_of("RW28B"), "28")
        self.assertEqual(cifp._runway_of("PDT"), "")


class ShippedDatasetTests(unittest.TestCase):
    """The dataset in navdata/cifp, read the way the bridge serves it."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.nav = cifp.NavData(str(Path(cls.tmp.name) / "no-simulator"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_index_names_the_cycle_and_the_airports_it_covers(self):
        summary = self.nav.summary()
        self.assertTrue(summary["dataset"]["available"])
        self.assertRegex(summary["dataset"]["cycle"], r"^\d{4}$")
        self.assertGreater(summary["dataset"]["airports"], 500)
        self.assertTrue(summary["available"], "the dataset alone is usable")

    def test_the_dataset_sid_starts_at_the_runway_and_ends_at_its_terminal_fix(self):
        payload = self.nav.procedures("KSEA", "sid", "BANGR9")
        self.assertTrue(payload["ok"])
        procedure = payload["procedures"]["sid"][0]
        transitions = {t["id"]: t for t in procedure["transitions"]}
        self.assertIn("RW16L", transitions)
        leg = transitions["RW16L"]
        self.assertEqual([p["id"] for p in leg["points"]], ["CAVOB", "RENBE", "RICHR", "TOMRE", "BANGR"])
        self.assertEqual(leg["points"][0]["terminator"], "DF")
        self.assertAlmostEqual(leg["points"][0]["lat"], 47.396192, places=5)
        self.assertAlmostEqual(leg["points"][0]["lon"], -122.308347, places=5)
        self.assertIn("16L", payload["runways"], "a threshold is needed to join the path to the runway")
        self.assertAlmostEqual(payload["runways"]["16L"]["lat"], 47.4638, places=3)

    def test_the_dataset_star_runs_from_its_transition_to_the_runway_transition(self):
        payload = self.nav.procedures("KPDX", "star", "HELNS6")
        self.assertTrue(payload["ok"])
        procedure = payload["procedures"]["star"][0]
        transitions = {t["id"]: t for t in procedure["transitions"]}
        leg = transitions["RW10B"]
        self.assertTrue(leg["combined"])
        self.assertEqual(leg["runway"], "10")
        self.assertEqual([p["id"] for p in leg["points"]], ["BTG", "KPDX"])
        self.assertTrue(leg["complete"])

    def test_an_airport_outside_the_coverage_is_not_invented(self):
        payload = self.nav.procedures("EGLL")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["reason"], "not-found")

    def test_every_airport_file_is_listed_and_every_leg_has_a_real_coordinate(self):
        index_path = Path(cifp.DATASET_DIR) / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        files = {path.stem for path in Path(cifp.DATASET_DIR).glob("*.json") if path.stem != "index"}
        self.assertEqual(files, set(index["airports"]))
        for airport in ("KSEA", "KPDX", "KJFK", "KLAX"):
            payload = json.loads((Path(cifp.DATASET_DIR) / (airport + ".json")).read_text(encoding="utf-8"))
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["airport"], airport)
            self.assertTrue(payload["cycle"])
            self.assertTrue(payload["procedures"])
            for kind in ("sid", "star"):
                for procedure in payload["procedures"].get(kind, []):
                    self.assertTrue(procedure["transitions"], procedure["id"])
                    for transition in procedure["transitions"]:
                        self.assertTrue(transition["points"], "%s %s %s" % (airport, procedure["id"], transition["id"]))
                        for point in transition["points"]:
                            self.assertTrue(-90 <= point["lat"] <= 90)
                            self.assertTrue(-180 <= point["lon"] <= 180)


if __name__ == "__main__":
    unittest.main(verbosity=2)
