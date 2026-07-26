Add-Type -AssemblyName System.Drawing

function New-RegimenIcon([int]$size, [string]$out) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  # ink background with a faint top glow
  $g.Clear([System.Drawing.Color]::FromArgb(255, 10, 11, 13))
  $glowRect = New-Object System.Drawing.Rectangle(0, 0, $size, [int]($size * 0.7))
  $glow = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $glowRect,
    [System.Drawing.Color]::FromArgb(28, 255, 255, 255),
    [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  $g.FillRectangle($glow, $glowRect)

  # amber momentum arc (270 degrees, open at top-right)
  $penW = [Math]::Max(4, $size * 0.055)
  $pad = $size * 0.16
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 171, 46), $penW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($pen, $pad, $pad, $size - 2 * $pad, $size - 2 * $pad, -90, 270)

  # serif R
  $fontSize = [float]($size * 0.34)
  $font = New-Object System.Drawing.Font("Georgia", $fontSize, [System.Drawing.FontStyle]::Italic)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 242, 239, 233))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, [float]($size * 0.02), $size, $size)
  $g.DrawString("R", $font, $brush, $rect, $fmt)

  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "wrote $out"
}

$dir = Join-Path $PSScriptRoot "..\public\icons"
New-Item -ItemType Directory -Force $dir | Out-Null
New-RegimenIcon 180 (Join-Path $dir "icon-180.png")
New-RegimenIcon 192 (Join-Path $dir "icon-192.png")
New-RegimenIcon 512 (Join-Path $dir "icon-512.png")
New-RegimenIcon 96  (Join-Path $dir "badge-96.png")
