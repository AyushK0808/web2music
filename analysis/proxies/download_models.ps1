# Step 0.4 — download the scorer models for S-D' (conditioning fidelity).
#
#   powershell -ExecutionPolicy Bypass -File analysis\proxies\download_models.ps1
#
# Files go to models\essentia\ and models\clap\ at the repo root, which is where
# analysis/proxies/score_fit.py looks by default. Existing files are skipped, so it is safe to re-run
# after an interrupted download (delete a half-downloaded file first; the check is by name, not size).
# About 2.3 GB in total; the CLAP checkpoint is almost all of it.

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$files = @(
  @{ dir = 'models\essentia'; url = 'https://essentia.upf.edu/models/feature-extractors/musicnn/msd-musicnn-1.pb' },
  @{ dir = 'models\essentia'; url = 'https://essentia.upf.edu/models/classification-heads/emomusic/emomusic-msd-musicnn-2.pb' },
  @{ dir = 'models\essentia'; url = 'https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb' },
  @{ dir = 'models\essentia'; url = 'https://essentia.upf.edu/models/classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.pb' },
  @{ dir = 'models\essentia'; url = 'https://essentia.upf.edu/models/classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.json' },
  @{ dir = 'models\clap';     url = 'https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt' }
)

foreach ($f in $files) {
  $dir = Join-Path $repo $f.dir
  New-Item -ItemType Directory -Force $dir | Out-Null
  $name = [IO.Path]::GetFileName(([Uri]$f.url).AbsolutePath)
  $dest = Join-Path $dir $name
  if (Test-Path $dest) { Write-Host "skip   $($f.dir)\$name (exists)"; continue }
  Write-Host "get    $($f.dir)\$name"
  $tmp = "$dest.part"
  try {
    Invoke-WebRequest -Uri $f.url -OutFile $tmp -UseBasicParsing
    Move-Item $tmp $dest
  } catch {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    throw "download failed for $($f.url): $($_.Exception.Message)"
  }
}

Write-Host "`nDone:"
Get-ChildItem (Join-Path $repo 'models') -Recurse -File |
  ForEach-Object { '{0,8:N1} MB  {1}' -f ($_.Length / 1MB), $_.FullName.Substring($repo.Path.Length + 1) }
