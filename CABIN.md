# Cabin Experience

Passenger announcements in the Stratos EFB. The tablet is the control head; the
PC sends the audio to X-Plane's master sound bus. A press on the tablet becomes
one command to the bridge, the bridge sends `PLAY` to the Stratos X-Plane plugin,
and the plugin plays the clip on X-Plane's bus.

## What is shipped

- `app/js/lib/cabin.js` — 72 announcements in seven phases, four voice slots,
  airline profiles, the text-token resolver and the automatic trigger rules.
- `app/js/efb/cabin.js` — the page: phase boxes, square icon tiles, playback
  panel, voice and airline setup, per-announcement auto switches.
- `stratos_cabin.py` — voice inventory, synthesis cache and playback through the
  X-Plane plugin.
- `plugins/Stratos` — the X-Plane plugin that plays the clip on the master bus.
- `stratos_bridge.py` — `GET /cabin`, `POST /cabin/play`, `POST /cabin/control`.

Nothing in the app synthesises speech in the browser and no system TTS voice is
used. A sentence is spoken only when a real source exists on the PC.

## Voice source 1 — a recorded pack

Put 16-bit PCM WAV files here, on the PC running the bridge:

```
<data dir>/cabin/voices/<slot>/<announcement-id>.wav
<data dir>/cabin/voices/pack.json
```

`<slot>` is one of `captain-male`, `captain-female`, `crew-male`, `crew-female`.
`<announcement-id>` is the id in `ANNOUNCEMENTS` (`taxi.remain-seated`,
`arr.welcome`, …). `pack.json` is optional but is what the interface credits:

```json
{ "name": "Crew pack A", "licence": "CC BY 4.0", "source": "recorded by …", "recordedAt": "2026-10" }
```

Only recordings you have the right to use belong here. A pack with no licence
line is still played, but the interface then names it without a licence, so the
gap is visible rather than implied away.

On Windows the data directory is the folder holding `stratos_bridge.py`; the
desktop app sets `STRATOS_DATA_DIR` to its own user-data folder.

## Voice source 2 — a neural voice

If the pack has no recording for a sentence, the bridge can synthesise it with
ElevenLabs. Set this **on the PC, before starting Stratos**:

```
ELEVENLABS_API_KEY=<your ElevenLabs API key>
```

Each slot's voice ID is set in `SLOTS` in `stratos_cabin.py`, or per slot with
`STRATOS_VOICE_<SLOT>` (for example `STRATOS_VOICE_CAPTAIN_FEMALE`). Audio is
requested as 22050 Hz PCM and wrapped as WAV.

The key is read by the bridge only. It is never sent to the tablet, never put in
a page, and never written to `localStorage`. Synthesised audio is cached under
`<data dir>/cabin/cache` and reused, so a repeat announcement costs nothing.
Synthesis is capped at 60 clips an hour per bridge process.

Without a key and without a recording the interface says so and the tile stays
disabled; the bridge refuses the request rather than reading it in a system
voice.

## Where the audio comes out

The bridge sends `PLAY <bus> <gain> <path>` to the plugin on `127.0.0.1:49410`.
Playback counts as started only after the plugin replies `OK`. An `ERR <reason>`
reply or no reply is reported as an error. Nothing plays on the PC's default
audio device.

The volume is applied to the samples in the file, and a volume change restarts
the clip at the same position. The plugin is built against the X-Plane SDK and
plays through `XPLMPlayPCMOnBus`; the SDK is not part of this repository.

## Automatic announcements

Off by default. When switched on, a per-announcement `Auto` switch decides which
ones may play. The rules read only what the bridge actually reports:

| Event | Rule | Announcement |
| --- | --- | --- |
| Taxi starts | phase `PARKED` → `TAXI` | Cabin crew prepare for takeoff |
| Airborne | phase `TAXI` → `AIRBORNE` | After takeoff |
| 10,000 ft | altitude crosses 10,000 ft climbing | Seatbelt sign update |
| Cruise | airborne, ≥ 18,000 ft, vertical speed within ±400 fpm | Reaching cruising altitude |
| Descent | 2,000 ft below the level reached, more than 300 fpm down | Beginning descent |
| Short final | airborne, below 3,000 ft AGL, descending | Final approach |
| Touchdown | phase `AIRBORNE` → `LANDED` | Welcome to destination |
| At the gate | phase `LANDED` → `PARKED` | Disembarkation |

There is no timer anywhere in the rules, and nothing fires twice in one flight.
The next taxi after arrival clears the record so the following flight can speak
again. Telemetry older than five seconds triggers nothing.

Everything else is manual and labelled so. Boarding, the seatbelt sign, door
arming and turbulence are not in the UDP feed; an automatic rule for them would
have to invent an event.

## Tested

```
node --test tests/cabin.test.mjs      # library, tokens, triggers, settings
python3 -m unittest tests.test_cabin  # inventory, validation, gain, plugin reply
```

The Python tests use an injected player and silent WAVs. The plugin-reply tests
use a local UDP stand-in, so they run without X-Plane. The page was exercised at 1180 × 820 and 390 × 844: play, pause,
resume, stop, volume, restore defaults, and the refusal when a voice has no
recording.

Announcements are a simulator feature. They are not for real-world use.
