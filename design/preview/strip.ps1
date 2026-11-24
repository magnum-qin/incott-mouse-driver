# 把 motion.mjs 录下的帧拼成一张连拍图（逐帧检查动效用）。一般不用直接调，motion.mjs 录完会自动拼。
#   powershell -NoProfile -File design/preview/strip.ps1 -Dir design/shots/motion/page [-Cols 6] [-Width 360] [-Every 1] [-Max 24]
#
#   -From / -Every / -Max  从第几帧开始、每隔几帧取一张、最多取几张（帧多了就抽稀看）
#   -Crop "x,y,w,h"       只取每帧的这块区域（放大看细节；配合把 -Width 调大）
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$Cols = 6, [int]$Width = 360, [int]$From = 0, [int]$Every = 1, [int]$Max = 24,
  [string]$Crop = '', [string]$Out = ''
)
Add-Type -AssemblyName System.Drawing
$Dir = (Resolve-Path $Dir).Path
# PowerShell 5.1 的 ConvertFrom-Json 把 JSON 数组当成一个对象输出，要自己拆开（否则 -Every / -Max 都不生效）
$frames = @(Get-Content (Join-Path $Dir 'frames.json') -Raw | ConvertFrom-Json | ForEach-Object { $_ })
$picked = @()
for ($i = $From; $i -lt $frames.Count -and $picked.Count -lt $Max; $i += $Every) { $picked += $frames[$i] }
if ($picked.Count -eq 0) { Write-Output 'no frames'; exit 1 }

$first = [System.Drawing.Image]::FromFile((Join-Path $Dir $picked[0].file))
if ($Crop) {
  $c = $Crop.Split(',') | ForEach-Object { [int]$_ }
  $src = New-Object System.Drawing.Rectangle -ArgumentList $c[0], $c[1], $c[2], $c[3]
} else {
  $src = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $first.Width, $first.Height
}
$first.Dispose()
$height = [int]($Width * $src.Height / $src.Width)
$labelH = 18
$rows = [int][Math]::Ceiling($picked.Count / $Cols)
$bmp = New-Object System.Drawing.Bitmap -ArgumentList ($Cols * $Width), ($rows * ($height + $labelH))
$g = [System.Drawing.Graphics]::FromImage($bmp)
if (-not $font) { $font = New-Object System.Drawing.Font -ArgumentList 'Consolas', 11 }
try {
  $g.Clear([System.Drawing.Color]::FromArgb(40, 40, 44))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  for ($i = 0; $i -lt $picked.Count; $i++) {
    $x = ($i % $Cols) * $Width
    $y = [int][Math]::Floor($i / $Cols) * ($height + $labelH)
    $img = [System.Drawing.Image]::FromFile((Join-Path $Dir $picked[$i].file))
    try {
      $to = New-Object System.Drawing.Rectangle -ArgumentList $x, ($y + $labelH), $Width, $height
      $g.DrawImage($img, $to, $src, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $img.Dispose() }
    $g.DrawString(('#{0}  +{1}ms' -f ($From + $i * $Every), $picked[$i].t), $font, [System.Drawing.Brushes]::White, ($x + 4), ($y + 1))
  }
  if (-not $Out) { $Out = Join-Path $Dir ("strip-{0}-{1}.png" -f $From, $Every) }
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose(); $bmp.Dispose(); $font.Dispose()
}
Write-Output $Out
