Add-Type -AssemblyName PresentationCore,WindowsBase
$outDir = Join-Path $PSScriptRoot '../Video/review'
New-Item -ItemType Directory -Force $outDir | Out-Null
$player = New-Object System.Windows.Media.MediaPlayer
$player.Volume = 0
$player.Open([Uri](Join-Path $PSScriptRoot '../Video/screen-recording.mp4'))
function Pump([int]$ms) {
  $end = [DateTime]::Now.AddMilliseconds($ms)
  while ([DateTime]::Now -lt $end) {
    $frame = New-Object System.Windows.Threading.DispatcherFrame
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::Background, [Action]{ $frame.Continue = $false }) | Out-Null
    [System.Windows.Threading.Dispatcher]::PushFrame($frame)
  }
}
$player.Play()
Pump 1500
$player.Pause()
$duration = $player.NaturalDuration.TimeSpan.TotalSeconds
Write-Output "Duration: $duration; dimensions: $($player.NaturalVideoWidth)x$($player.NaturalVideoHeight)"
for ($i=0; $i -lt 12; $i++) {
  $sec = [Math]::Min($duration-0.2, $i * $duration / 12)
  $player.Position = [TimeSpan]::FromSeconds($sec)
  $player.Play()
  Pump 500
  $visual = New-Object System.Windows.Media.DrawingVisual
  $dc = $visual.RenderOpen()
  $dc.DrawVideo($player, [System.Windows.Rect]::new(0,0,1280,720))
  $dc.Close()
  $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(1280,720,96,96,[System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($visual)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream = [System.IO.File]::Create((Join-Path $outDir "frame-$i.png"))
  $encoder.Save($stream)
  $stream.Close()
  $player.Pause()
}
$player.Close()
