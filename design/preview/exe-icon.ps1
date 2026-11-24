# 从 .exe 里取出内嵌的图标存成 PNG——改了图标之后要确认「打进文件里的」确实是新的，
# 只看源文件不够（Tauri 的构建脚本以前不会因为图标文件变了而重新编译资源）。
#   powershell -NoProfile -File design/preview/exe-icon.ps1 -Exe src-tauri/target/release/incott-mouse-driver.exe 
#     -Out design/shots/icon-from-exe.png -Size 256
#   同一路径的程序换过图标时，系统可能返回缓存的旧图：先复制成一个新文件名再取。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Size = 256
)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class IconExtract {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int PrivateExtractIcons(string fileName, int index, int cx, int cy, IntPtr[] icons, int[] ids, int count, int flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
}
"@
$path = (Resolve-Path $Exe).Path
$handles = New-Object IntPtr[] 1
$ids = New-Object int[] 1
$n = [IconExtract]::PrivateExtractIcons($path, 0, $Size, $Size, $handles, $ids, 1, 0)
if ($n -lt 1 -or $handles[0] -eq [IntPtr]::Zero) { throw "no icon found in $path" }
$icon = [System.Drawing.Icon]::FromHandle($handles[0])
$bmp = $icon.ToBitmap()
$target = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("{0} -> {1}x{2}" -f $path, $bmp.Width, $bmp.Height)
$bmp.Dispose()
$icon.Dispose()
[void][IconExtract]::DestroyIcon($handles[0])
