# 截图局部放大（设计校对用，零依赖，用系统自带的 System.Drawing）。
#   powershell -NoProfile -File design/preview/crop.ps1 -In 截图.png -Out 局部.png -X 700 -Y 140 -W 200 -H 70 -Zoom 4
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$X = 0, [int]$Y = 0, [int]$W = 200, [int]$H = 100, [int]$Zoom = 4
)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Resolve-Path $In).Path)
try {
  $bw = [int]($W * $Zoom)
  $bh = [int]($H * $Zoom)
  $dst = New-Object System.Drawing.Bitmap -ArgumentList $bw, $bh
  $g = [System.Drawing.Graphics]::FromImage($dst)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $to = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $bw, $bh
    $from = New-Object System.Drawing.Rectangle -ArgumentList $X, $Y, $W, $H
    $g.DrawImage($src, $to, $from, [System.Drawing.GraphicsUnit]::Pixel)
  } finally { $g.Dispose() }
  # -Out 是绝对路径时不能再和当前目录拼接（拼出来的路径格式非法）
  $target = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
  try { $dst.Save($target, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $dst.Dispose() }
} finally { $src.Dispose() }
Write-Output $Out
