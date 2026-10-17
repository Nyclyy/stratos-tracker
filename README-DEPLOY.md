# Stratos: deployment notes

## What is in this folder
- `index.html`: landing page. `app/`: the tracker (this is what the website, the iPhone app and the Windows app all use).
- `electron-main.cjs`, `package.json`, `.github/workflows/release-windows.yml`: build the Windows installer.
- `stratos_bridge.py` + `stratos.html`: optional, only for showing your own aircraft from X-Plane or MSFS.
- `stratos.html` and `app/index.html` are the same file. If you edit one, copy it over the other.

## 1. Put the website online (free, needed for iPhone)
1. Upload everything in this folder to your GitHub repository (keep `app/` and `.github/` together).
2. Repository **Settings > Pages > Deploy from a branch > main / (root)**. Wait for the green check.
3. Your site is at `https://nyclyy.github.io/Stratos-track/`. The tracker is at `.../app/`.

## 2. iPhone app (free, no App Store, no Mac)
1. On the iPhone, open `https://nyclyy.github.io/Stratos-track/app/` in **Safari**.
2. Tap **Share > Add to Home Screen > Add**.
It opens full screen with its own icon and, after the first visit, also opens with no signal (live data and map tiles still need internet).
When you upload a new version, open the app once while online and it updates itself.

## 3. Windows app (.exe)
The installer is built by GitHub, not on your PC, and every run now publishes it to **Releases**, which is what the website's download button uses.
1. Upload all files, including `.github/workflows/release-windows.yml`, `package.json` and `electron-main.cjs`.
2. **Actions > Build Windows installer > Run workflow**. After 2 to 5 minutes the run turns green and a new Release (for example `v1.0.3`) appears on the repo's front page with `Stratos-Setup.exe` attached.
3. The landing page's **Download for PC** button then downloads it. Until a Release exists, that button says "see Releases" instead of giving a broken link.
Already have a finished run but no Release? Open **Releases > Draft a new release**, type a tag like `v1.0.0`, drag the unzipped `Stratos-Setup.exe` into the box, and click **Publish release**.
The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC". Choose **More info > Run anyway**.

## 4. Your own aircraft from a simulator (optional)
Run `python3 stratos_bridge.py` on the PC that runs the sim, then open the address it prints in Safari on the iPhone (or in a browser on the PC). X-Plane needs the UDP output turned on; MSFS needs `pip install SimConnect` once. A hosted website cannot reach a PC on its own, so this is the only part that needs the bridge.

## Notes
- Aircraft shown on the map are real ADS-B reports from community services. Nothing is simulated. If every service is unreachable the app says so and shows no aircraft.
- A contrail starts building when the app first sees an aircraft, so it shows the path since then, not the whole flight.
- Official FAA chart PDFs open inside the app. If a browser refuses to embed one, use "Open outside app".
- Map sources and aviation data remain subject to their providers' terms. Not for real-world navigation.
