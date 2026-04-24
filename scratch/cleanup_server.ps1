$content = Get-Content 'd:\IA\newclaw\src\dashboard\DashboardServer.ts' -Raw
# Find the first occurrence of the duplicated block and remove it
$pattern = '(?s)// CLEANED.*?this\.app\.get\(''/api/ollama/exists/:model'''
# We want to keep the exists endpoint start but remove everything before it that is junk
if ($content -match $pattern) {
    $junk = $content.Substring($content.IndexOf("// CLEANED"), $content.IndexOf("this.app.get('/api/ollama/exists/:model'") - $content.IndexOf("// CLEANED"))
    $newContent = $content.Replace($junk, "});`n`n        ")
    Set-Content 'd:\IA\newclaw\src\dashboard\DashboardServer.ts' $newContent -Encoding UTF8
    Write-Host "File cleaned successfully"
} else {
    Write-Host "Pattern not found"
}
