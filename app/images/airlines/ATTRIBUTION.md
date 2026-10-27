# Airline marks

These files are the operator marks the EFB lays into the home-screen wallpaper
when an airline is selected or detected. They are bundled with the app; nothing
is hotlinked from a third party at runtime.

Every file was downloaded from Wikimedia Commons, where its file page records it
as **public domain** (the artwork consists only of simple shapes and/or text,
below the threshold of originality). The EFB renders each mark as a single-tone
mask in that airline's accent colour, which is an adaptation of a public-domain
image.

| File | Airline | Source on Wikimedia Commons |
| --- | --- | --- |
| `ACA.svg` | Air Canada | [Air Canada logo.svg](https://commons.wikimedia.org/wiki/File:Air_Canada_logo.svg) |
| `AAL.svg` | American Airlines | [American Airlines wordmark (2013).svg](https://commons.wikimedia.org/wiki/File:American_Airlines_wordmark_(2013).svg) |
| `BAW.svg` | British Airways | [BRITISH AIRWAYS logo.svg](https://commons.wikimedia.org/wiki/File:BRITISH_AIRWAYS_logo.svg) |
| `DAL.svg` | Delta Air Lines | [Delta Air Lines 2007 symbol.svg](https://commons.wikimedia.org/wiki/File:Delta_Air_Lines_2007_symbol.svg) |
| `DLH.svg` | Lufthansa | [Lufthansa Logo 2018.svg](https://commons.wikimedia.org/wiki/File:Lufthansa_Logo_2018.svg) |
| `EZY.svg` | easyJet | [EasyJet logo.svg](https://commons.wikimedia.org/wiki/File:EasyJet_logo.svg) |
| `KLM.svg` | KLM | [KLM logo.svg](https://commons.wikimedia.org/wiki/File:KLM_logo.svg) |
| `QFA.svg` | Qantas | [Qantas wordmark 2016.svg](https://commons.wikimedia.org/wiki/File:Qantas_wordmark_2016.svg) |
| `RYR.svg` | Ryanair | [Ryanair logo.svg](https://commons.wikimedia.org/wiki/File:Ryanair_logo.svg) |

## Trademarks

Public domain status covers copyright only. Each mark is a trademark of its
airline. It is used here solely to identify the operator whose designator the
active flight plan filed, in a personal flight-simulation tool. Nothing in this
use implies affiliation with, sponsorship by, or endorsement from any airline.

United Airlines is deliberately absent: its current globe and wordmark are not
published under a licence that permits redistribution, so the EFB draws that
operator with a typographic roundel instead of a copied mark.

## Adding an airline

1. Confirm the file's licence on its Commons page permits redistribution.
2. Save it here as `<ICAO>.svg` (a vector mark with a `viewBox` and no embedded
   raster images or external references).
3. Add the source, licence and any author credit to the table above.
4. Point the airline's entry at `images/airlines/<ICAO>.svg` in
   `app/js/lib/airlines.js`.
