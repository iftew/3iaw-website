param([string]$Shot, [string]$Out)
# One-off: 1280x720 YouTube thumbnail for the Halloween Tools Pack, picture + name only (deleted after use)
Add-Type -AssemblyName System.Drawing
$W = 1280; $H = 720

# ---- 1. cut the tools out of the green screen ----
$src = New-Object Drawing.Bitmap $Shot
$crop = New-Object Drawing.Rectangle 340, 8, 470, 672
$tools = $src.Clone($crop, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$src.Dispose()
$rect = New-Object Drawing.Rectangle 0, 0, $tools.Width, $tools.Height
$data = $tools.LockBits($rect, [Drawing.Imaging.ImageLockMode]::ReadWrite, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $tools.Height)
[Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
for ($i = 0; $i -lt $bytes.Length; $i += 4) {
  $b = $bytes[$i]; $g = $bytes[$i + 1]; $r = $bytes[$i + 2]
  $mx = [Math]::Max($r, $b)
  if ($g -gt 90 -and $g -gt $mx * 1.35) {
    $bytes[$i + 3] = [byte]([Math]::Max(0, [Math]::Min(255, 255 - (($g - $mx) - 40) * 4)))
    $bytes[$i + 1] = [byte]$mx
  } elseif ($g -gt $mx) { $bytes[$i + 1] = [byte]$mx }
}
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$tools.UnlockBits($data)

$bmp = New-Object Drawing.Bitmap $W, $H
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.CompositingQuality = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
$g.Clear([Drawing.Color]::FromArgb(7, 4, 13))

function Glow($x, $y, $w, $h, $a, $r, $gg, $b) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $p.AddEllipse([float]$x, [float]$y, [float]$w, [float]$h)
  $br = New-Object Drawing.Drawing2D.PathGradientBrush $p
  $br.CenterColor = [Drawing.Color]::FromArgb($a, $r, $gg, $b)
  $br.SurroundColors = @([Drawing.Color]::FromArgb(0, $r, $gg, $b))
  $script:g.FillPath($br, $p)
}

# ---- 2. spooky scene: color washes, light rays, moon, fog ----
Glow -380 180 1000 900 170 255 95 10       # orange wash, bottom left
Glow 560 -360 1000 900 170 120 40 230      # purple wash, top right
$cx = 960; $cy = 350
for ($k = 0; $k -lt 28; $k++) {
  # thin light rays fanning out behind the tools
  $a1 = [Math]::PI * 2 * $k / 28; $a2 = $a1 + 0.07
  $ray = New-Object Drawing.Drawing2D.GraphicsPath
  $ray.AddPolygon(@((New-Object Drawing.PointF $cx, $cy), (New-Object Drawing.PointF ($cx + 1400 * [Math]::Cos($a1)), ($cy + 1400 * [Math]::Sin($a1))), (New-Object Drawing.PointF ($cx + 1400 * [Math]::Cos($a2)), ($cy + 1400 * [Math]::Sin($a2)))))
  $col = if ($k % 2) { [Drawing.Color]::FromArgb(10, 255, 170, 60) } else { [Drawing.Color]::FromArgb(8, 190, 120, 255) }
  $g.FillPath((New-Object Drawing.SolidBrush $col), $ray)
}
Glow 680 60 560 580 150 255 130 30          # hot glow behind the tools
# moon
Glow 1000 -60 300 300 120 255 230 170
$g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(235, 255, 236, 196))), 1070, 12, 160, 160)
$g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(40, 160, 120, 90))), 1110, 50, 34, 30)
$g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(32, 160, 120, 90))), 1165, 105, 26, 22)
$g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(28, 160, 120, 90))), 1090, 115, 18, 16)
# low purple fog
foreach ($f in @(@(-100, 560, 900, 260, 90), @(500, 600, 1000, 240, 80), @(900, 520, 600, 260, 70))) { Glow $f[0] $f[1] $f[2] $f[3] $f[4] 150 90 220 }

# ---- 3. the tools, big, with an orange rim and purple aura ----
$scale = 1.02
$tw = [int]($tools.Width * $scale); $th = [int]($tools.Height * $scale)
$tx = 735; $ty = [int](($H - $th) / 2) + 12
function Aura($r, $gg, $b, [float]$shrink, [int]$grow, [int]$passes) {
  $cm = New-Object Drawing.Imaging.ColorMatrix
  $cm.Matrix00 = 0; $cm.Matrix11 = 0; $cm.Matrix22 = 0; $cm.Matrix33 = 1
  $cm.Matrix40 = $r / 255; $cm.Matrix41 = $gg / 255; $cm.Matrix42 = $b / 255
  $ia = New-Object Drawing.Imaging.ImageAttributes
  $ia.SetColorMatrix($cm)
  $tiny = New-Object Drawing.Bitmap ([int]($script:tools.Width / $shrink)), ([int]($script:tools.Height / $shrink))
  $tg = [Drawing.Graphics]::FromImage($tiny)
  $tg.InterpolationMode = 'HighQualityBicubic'
  $tg.DrawImage($script:tools, (New-Object Drawing.Rectangle 0, 0, $tiny.Width, $tiny.Height), 0, 0, $script:tools.Width, $script:tools.Height, [Drawing.GraphicsUnit]::Pixel, $ia)
  $tg.Dispose()
  for ($p = 0; $p -lt $passes; $p++) { $script:g.DrawImage($tiny, (New-Object Drawing.Rectangle ($script:tx - $grow), ($script:ty - $grow), ($script:tw + 2 * $grow), ($script:th + 2 * $grow))) }
  $tiny.Dispose()
}
Aura 150 70 255 16 60 2      # wide purple aura
Aura 255 120 20 9 26 3       # orange rim
Aura 255 210 120 5 8 1       # thin hot edge
$g.DrawImage($tools, (New-Object Drawing.Rectangle $tx, $ty, $tw, $th))

# ---- 4. dark edges ----
$vp = New-Object Drawing.Drawing2D.GraphicsPath
$vp.AddEllipse(-260, -220, $W + 520, $H + 440)
$vb = New-Object Drawing.Drawing2D.PathGradientBrush $vp
$vb.CenterColor = [Drawing.Color]::FromArgb(0, 0, 0, 0)
$vb.SurroundColors = @([Drawing.Color]::FromArgb(245, 0, 0, 0))
$vb.FocusScales = New-Object Drawing.PointF 0.35, 0.3
$g.FillRectangle($vb, 0, 0, $W, $H)

# ---- 5. the name: tilted, thick outline, drop shadow, glow ----
$g.TranslateTransform(60, 110)
$g.RotateTransform(-5)
function Title([string]$text, [float]$size, [float]$x, [float]$y, $fill, $glowColor) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $p.AddString($text, (New-Object Drawing.FontFamily 'Segoe UI Black'), 0, $size, (New-Object Drawing.PointF $x, $y), [Drawing.StringFormat]::GenericTypographic)
  foreach ($w in 46, 34, 24) {
    $gp = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(26, $glowColor.R, $glowColor.G, $glowColor.B)), $w
    $gp.LineJoin = 'Round'; $script:g.DrawPath($gp, $p)
  }
  $m = New-Object Drawing.Drawing2D.Matrix
  $m.Translate(7, 10)
  $sh = $p.Clone(); $sh.Transform($m)
  $sp = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(200, 0, 0, 0)), 18
  $sp.LineJoin = 'Round'; $script:g.DrawPath($sp, $sh); $script:g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(200, 0, 0, 0))), $sh)
  $op = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255, 12, 6, 20)), 16
  $op.LineJoin = 'Round'; $script:g.DrawPath($op, $p)
  $script:g.FillPath($fill, $p)
  $hl = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(70, 255, 255, 255)), 2
  $script:g.DrawPath($hl, $p)
}
$orangeTop = New-Object Drawing.Drawing2D.LinearGradientBrush (New-Object Drawing.Rectangle 0, 20, 10, 130), ([Drawing.Color]::FromArgb(255, 255, 222, 120)), ([Drawing.Color]::FromArgb(255, 255, 104, 14)), 90
$whiteMid = New-Object Drawing.Drawing2D.LinearGradientBrush (New-Object Drawing.Rectangle 0, 150, 10, 190), ([Drawing.Color]::FromArgb(255, 255, 255, 255)), ([Drawing.Color]::FromArgb(255, 214, 200, 236)), 90
$orangeLow = New-Object Drawing.Drawing2D.LinearGradientBrush (New-Object Drawing.Rectangle 0, 345, 10, 130), ([Drawing.Color]::FromArgb(255, 255, 222, 120)), ([Drawing.Color]::FromArgb(255, 255, 104, 14)), 90
Title 'HALLOWEEN' 118 0 20 $orangeTop ([Drawing.Color]::FromArgb(255, 255, 120, 20))
Title 'TOOLS' 196 -6 132 $whiteMid ([Drawing.Color]::FromArgb(255, 170, 110, 255))
Title 'PACK' 118 0 345 $orangeLow ([Drawing.Color]::FromArgb(255, 255, 120, 20))
$g.ResetTransform()

$g.Dispose()
New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null
$bmp.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $tools.Dispose()
Get-Item $Out | Select-Object FullName, Length
