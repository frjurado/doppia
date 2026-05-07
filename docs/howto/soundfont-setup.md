# SoundFont Setup for MIDI Playback

Piano samples must be uploaded to MinIO before the playback bar produces audio.
Your local MinIO credentials (from `.env`):

| Setting | Value |
|---|---|
| Console | http://localhost:9001 |
| API | http://localhost:9000 |
| User | `minioadmin` |
| Password | `minioadmin` |
| Bucket | `doppia-local` |

---

## Step 1 — Download the samples

Open PowerShell, navigate to a temporary directory, and run:

```powershell
$base = "https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/samples/piano"
$notes = "C1","Ds1","Fs1","A1","C2","Ds2","Fs2","A2","C3","Ds3","Fs3","A3",
         "C4","Ds4","Fs4","A4","C5","Ds5","Fs5","A5","C6","Ds6","Fs6","A6",
         "C7","Ds7","Fs7","A7"

New-Item -ItemType Directory -Force -Path "piano-samples" | Out-Null
Set-Location "piano-samples"

foreach ($note in $notes) {
    Invoke-WebRequest -Uri "$base/$note.mp3" -OutFile "$note.mp3"
    Write-Host "Downloaded $note.mp3"
}
```

28 files, ~1.5 MB total.

---

## Step 2 — Upload to MinIO

1. Open http://localhost:9001 and log in (`minioadmin` / `minioadmin`)
2. **Buckets** → **doppia-local** → **Browse**
3. Create path `soundfonts/piano/` (New Folder → `soundfonts`, then New Folder → `piano` inside it)
4. Upload all 28 `.mp3` files into `soundfonts/piano/`

---

## Step 3 — Make the prefix publicly readable

The MinIO console's "Anonymous" tab was removed in newer versions. Use `mc` (the MinIO CLI) instead.

In PowerShell, run:

```powershell
# Download mc.exe
Invoke-WebRequest -Uri "https://dl.min.io/client/mc/release/windows-amd64/mc.exe" -OutFile "$env:TEMP\mc.exe"

# Register your local MinIO instance
& "$env:TEMP\mc.exe" alias set local http://localhost:9000 minioadmin minioadmin

# Grant anonymous read on the soundfonts/ prefix
& "$env:TEMP\mc.exe" anonymous set download local/doppia-local/soundfonts/
```

Verify:

```powershell
# Should print: Access permission for 'local/doppia-local/soundfonts/' is 'download'
& "$env:TEMP\mc.exe" anonymous get local/doppia-local/soundfonts/

# Should return StatusCode 200
Invoke-WebRequest -Uri "http://localhost:9000/doppia-local/soundfonts/piano/C4.mp3" -Method Head
```

---

## Step 4 — Configure the frontend

Create `frontend/.env.local` (if it doesn't exist) and add:

```
VITE_SOUNDFONT_BASE_URL=http://localhost:9000/doppia-local
```

---

## Step 5 — Restart the dev server

Vite reads `.env.local` only at startup:

```powershell
cd frontend
npm run dev
```

Open the score viewer and click **Play**. The sampler loads the 28 files on first click (~1–2 s), then playback begins.
