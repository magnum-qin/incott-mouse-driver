# 图标小尺寸可辨性对比图（设计校对用）：把几张图标缩到任务栏 / 开始菜单的真实尺寸，
# 分别放在深色和浅色底色上，最后整体放大 2 倍（最近邻）方便看。
#   powershell -NoProfile -File design/preview/icon-sheet.ps1 -Out design/icon/compare.png 
#     -Icons "a.png;b.png" -Labels "A;B" -SizeList "128,64,48,32,24,16"
#   注意：用 -File 调用时 PowerShell 传不进数组，多个路径用分号分隔。默认放大 2 倍。
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Icons,
  [string]$Labels = '',
  [string]$SizeList = '128,64,48,32,24,16',
  [int]$Zoom = 2
)
Add-Type -AssemblyName System.Drawing

function Resize-Step([System.Drawing.Bitmap]$src, [int]$size) {
  # halve while the step is more than 2x, then one high-quality pass (avoids aliasing on big reductions)
  $cur = $src
  while ([int]($cur.Width / 2) -ge $size) {
    $half = New-Object System.Drawing.Bitmap -ArgumentList ([int]($cur.Width / 2)), ([int]($cur.Height / 2))
    $g = [System.Drawing.Graphics]::FromImage($half)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($cur, 0, 0, $half.Width, $half.Height)
    $g.Dispose()
    if ($cur -ne $src) { $cur.Dispose() }
    $cur = $half
  }
  $dst = New-Object System.Drawing.Bitmap -ArgumentList $size, $size
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($cur, 0, 0, $size, $size)
  $g.Dispose()
  if ($cur -ne $src) { $cur.Dispose() }
  return $dst
}

$iconList = @($Icons.Split(';') | Where-Object { $_ })
$labelList = @($Labels.Split(';') | Where-Object { $_ })
if ($labelList.Count -ne $iconList.Count) { $labelList = @(1..$iconList.Count | ForEach-Object { [string]$_ }) }
$Sizes = @($SizeList.Split(',') | ForEach-Object { [int]$_ })

$dark = [System.Drawing.Color]::FromArgb(31, 31, 31)
$light = [System.Drawing.Color]::FromArgb(243, 243, 243)
$rowH = 150
$cellW = 150
$labelW = 40
$halfW = $labelW + $Sizes.Count * $cellW
$sheet = New-Object System.Drawing.Bitmap -ArgumentList ($halfW * 2), ($rowH * $iconList.Count)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear($dark)
$lightBrush = New-Object System.Drawing.SolidBrush -ArgumentList $light
$g.FillRectangle($lightBrush, $halfW, 0, $halfW, $sheet.Height)
$textOnDark = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(200, 200, 200))
$textOnLight = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(60, 60, 60))
$font = New-Object System.Drawing.Font -ArgumentList 'Consolas', 12

for ($i = 0; $i -lt $iconList.Count; $i++) {
  $path = (Resolve-Path $iconList[$i]).Path
  $src = [System.Drawing.Image]::FromFile($path)
  $y = $i * $rowH
  $label = $labelList[$i]
  $g.DrawString($label, $font, $textOnDark, 8, ($y + 62))
  $g.DrawString($label, $font, $textOnLight, ($halfW + 8), ($y + 62))
  for ($s = 0; $s -lt $Sizes.Count; $s++) {
    $size = $Sizes[$s]
    $small = Resize-Step $src $size
    $x = $labelW + $s * $cellW + [int](($cellW - $size) / 2)
    $cy = $y + [int](($rowH - $size) / 2)
    $g.DrawImageUnscaled($small, $x, $cy)
    $g.DrawImageUnscaled($small, ($halfW + $x), $cy)
    $small.Dispose()
  }
  $src.Dispose()
}
$g.Dispose()

$big = New-Object System.Drawing.Bitmap -ArgumentList ($sheet.Width * $Zoom), ($sheet.Height * $Zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g2.DrawImage($sheet, 0, 0, $big.Width, $big.Height)
$g2.Dispose()
$sheet.Dispose()
$target = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
$big.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()
Write-Output "sizes left to right: $($Sizes -join ', ')  (sheet magnified ${Zoom}x)"
