// What Windows does for a picture, on Windows and under WSL: both scripts are PowerShell, taking
// what they need from the environment.

// GDI+ reads PNG, JPEG, GIF, BMP and TIFF but no WebP; the codecs of Windows read that too, so a
// picture GDI+ gives up on goes through them and comes back as a PNG in memory.
const OPEN_PICTURE = String.raw`
function Open-Picture ($path) {
  try { return [System.Drawing.Image]::FromFile($path) } catch { }
  Add-Type -AssemblyName PresentationCore, WindowsBase
  $file = [System.IO.File]::OpenRead($path)
  try {
    $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($file, 'None', 'OnLoad')
    $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add($decoder.Frames[0])
    $memory = New-Object System.IO.MemoryStream
    $encoder.Save($memory)
  } finally {
    $file.Dispose()
  }
  return [System.Drawing.Image]::FromStream($memory)
}
`

// A window by the pointer: Windows Terminal draws no pictures, and a WSLg window does not know
// where the pointer is. Shows IMAGE_PREVIEW_FILE, its longer side IMAGE_PREVIEW_SIZE at most, for
// IMAGE_PREVIEW_LIFE seconds at most. Prints `shown` once the window is up, or a line starting
// with `error`, then a `.` every tenth of a second: the reader wakes on each and can end the
// program, and with no reader left the write fails and it ends itself. The focus and the pointer
// stay with the terminal.
export const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
${OPEN_PICTURE}
$largest = if ($env:IMAGE_PREVIEW_SIZE) { [int]$env:IMAGE_PREVIEW_SIZE } else { 800 }
$life = if ($env:IMAGE_PREVIEW_LIFE) { [int]$env:IMAGE_PREVIEW_LIFE } else { 120 }
# A window that takes no focus, stays on top and lets the pointer through. Compiled once into the
# temp folder: compiling takes a second.
$assembly = Join-Path $env:TEMP 'image-preview-popup-1.dll'
if (-not (Test-Path $assembly)) {
  try {
  Add-Type -OutputAssembly $assembly -OutputType Library -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
public class ImagePreviewPopup : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams p = base.CreateParams;
      p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008 | 0x00000020;
      return p;
    }
  }
}
'@
  } catch {
    # Another preview is compiling it this very second: its file is the one loaded.
  }
}
Add-Type -Path $assembly
try { $image = Open-Picture $env:IMAGE_PREVIEW_FILE } catch { [Console]::Out.WriteLine('error: cannot read the image'); exit 1 }
$cursor = [System.Windows.Forms.Cursor]::Position
$area = [System.Windows.Forms.Screen]::FromPoint($cursor).WorkingArea
$fit = [Math]::Min(1.0, [Math]::Min($largest / [Math]::Max($image.Width, $image.Height), [Math]::Min($area.Width * 0.7 / $image.Width, $area.Height * 0.7 / $image.Height)))
$pad = 6
$gap = 18
$width = [int]($image.Width * $fit) + $pad * 2
$height = [int]($image.Height * $fit) + $pad * 2
# Above the pointer and to its right, or below and to its left where there is no room: the pointer
# stays over the terminal.
$x = $cursor.X + $gap
$y = $cursor.Y - $gap - $height
if ($y -lt $area.Top) { $y = $cursor.Y + $gap }
if ($x + $width -gt $area.Right) { $x = $cursor.X - $gap - $width }
$x = [Math]::Max($area.Left, [Math]::Min($x, $area.Right - $width))
$y = [Math]::Max($area.Top, [Math]::Min($y, $area.Bottom - $height))
$form = New-Object ImagePreviewPopup
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Bounds = New-Object System.Drawing.Rectangle($x, $y, $width, $height)
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
$form.Padding = New-Object System.Windows.Forms.Padding($pad)
$form.Opacity = 0.99
$box = New-Object System.Windows.Forms.PictureBox
$box.Dock = 'Fill'
$box.SizeMode = 'Zoom'
$box.Image = $image
$form.Controls.Add($box)
$form.add_Shown({ [Console]::Out.WriteLine('shown'); [Console]::Out.Flush() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $life * 1000
$timer.add_Tick({ $form.Close() })
$timer.Start()
$beat = New-Object System.Windows.Forms.Timer
$beat.Interval = 100
$beat.add_Tick({ try { [Console]::Out.WriteLine('.'); [Console]::Out.Flush() } catch { $form.Close() } })
$beat.Start()
[System.Windows.Forms.Application]::Run($form)
`

/** The script as `-EncodedCommand` takes it: UTF-16LE in base64. */
export function encodedCommand (script: string) {
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  return bytes.toBase64()
}

// Reads a picture with what every Windows has, for a machine without ImageMagick: writes
// IMAGE_PREVIEW_FILE as IMAGE_PREVIEW_FORMAT (`bmp` or `png`) to IMAGE_PREVIEW_OUT_NAME in
// IMAGE_PREVIEW_OUT_DIR, its longer side IMAGE_PREVIEW_SIDE (`n` stretched or shrunk to it, `n>`
// only shrunk, none as it is). The folder comes apart from the name because WSLENV carries over
// only a path that exists.
export const READER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
${OPEN_PICTURE}
$image = Open-Picture $env:IMAGE_PREVIEW_FILE
$side = "$env:IMAGE_PREVIEW_SIDE"
$scale = 1.0
if ($side) {
  $scale = [int]$side.TrimEnd('>') / [Math]::Max($image.Width, $image.Height)
  if ($side.EndsWith('>')) { $scale = [Math]::Min(1.0, $scale) }
}
$width = [Math]::Max(1, [int]($image.Width * $scale))
$height = [Math]::Max(1, [int]($image.Height * $scale))
$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$graphics.DrawImage($image, 0, 0, $width, $height)
$graphics.Dispose()
[System.IO.Directory]::CreateDirectory($env:IMAGE_PREVIEW_OUT_DIR) | Out-Null
$format = if ($env:IMAGE_PREVIEW_FORMAT -eq 'png') { [System.Drawing.Imaging.ImageFormat]::Png } else { [System.Drawing.Imaging.ImageFormat]::Bmp }
$bitmap.Save((Join-Path $env:IMAGE_PREVIEW_OUT_DIR $env:IMAGE_PREVIEW_OUT_NAME), $format)
`

/**
 * A PowerShell script run with `env`: no profile, no questions, no script policy. From WSL the
 * variables cross into Windows through WSLENV, the ones in `paths` turned into Windows paths.
 */
function powershell (script: string, env: Record<string, string>, paths: string[], inherited?: string) {
  const names = Object.keys(env).map(name => (paths.includes(name) ? `${name}/p` : name))
  return {
    argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script)],
    env: { ...env, WSLENV: [inherited, ...names].filter(Boolean).join(':') }
  }
}

/** The window of the picture `file`, `size` its longer side at most, gone after `life` seconds. */
export function windowCommand (file: string, size: number, life: number, inherited?: string) {
  const env = { IMAGE_PREVIEW_FILE: file, IMAGE_PREVIEW_SIZE: String(size), IMAGE_PREVIEW_LIFE: String(life) }
  return powershell(WINDOWS, env, ['IMAGE_PREVIEW_FILE'], inherited)
}

/** Windows reading `file` into `name` in the folder `dir`, as `READER` says. */
export function readerCommand (file: string, dir: string, name: string, format: 'bmp' | 'png', side: string | undefined, inherited?: string) {
  const env = { IMAGE_PREVIEW_FILE: file, IMAGE_PREVIEW_OUT_DIR: dir, IMAGE_PREVIEW_OUT_NAME: name, IMAGE_PREVIEW_FORMAT: format, IMAGE_PREVIEW_SIDE: side ?? '' }
  return powershell(READER, env, ['IMAGE_PREVIEW_FILE', 'IMAGE_PREVIEW_OUT_DIR'], inherited)
}
