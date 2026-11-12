# Builds the extra pages of 3iaw.com from index.html, so the homepage stays the one place to edit:
#   systems/<name>.html  one page per system (served as /systems/<name>)
#   systems.html         all systems (/systems)
#   ugc.html             custom UGC (/ugc)
#   games.html           the Roblox games (/games)
#   sitemap.xml          every page above plus the homepage
# Run it after changing systems, UGC or games on the homepage, then commit the results:
#   powershell -ExecutionPolicy Bypass -File scripts\build-pages.ps1
# This file is plain ASCII on purpose (Windows PowerShell reads scripts as ANSI); special characters are HTML entities.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object Text.UTF8Encoding $false
$index = [IO.File]::ReadAllText((Join-Path $root 'index.html'), $utf8)
$today = (Get-Date).ToString('yyyy-MM-dd')
$site = 'https://3iaw.com'

function Slug([string]$name) { ($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-') }
function Html([string]$s) { $s.Replace('&', '&amp;').Replace('"', '&quot;').Replace('<', '&lt;').Replace('>', '&gt;') }
function PlainText([string]$html) {
  $t = [regex]::Replace($html, '<[^>]+>', ' ')
  $t = [Net.WebUtility]::HtmlDecode($t)
  ([regex]::Replace($t, '\s+', ' ')).Trim()
}
function Short([string]$text, [int]$max) {
  if ($text.Length -le $max) { return $text }
  $cut = $text.Substring(0, $max)
  $cut.Substring(0, $cut.LastIndexOf(' ')).TrimEnd(',', '.', ':', ';') + '...'
}
function Save([string]$rel, [string]$content) {
  $path = Join-Path $root $rel
  New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText($path, $content, $utf8)
  "  wrote $rel"
}

# ---------- pieces taken from the homepage ----------
$shopJson = [regex]::Match($index, '(?s)<script id="shopData" type="application/json">(.*?)</script>').Groups[1].Value
if (-not $shopJson) { throw 'shopData not found in index.html' }
$shopScript = '<script id="shopData" type="application/json">' + $shopJson + '</script>'

$articles = @()
foreach ($m in [regex]::Matches($index, '(?s)<article class="sys [^"]*">.*?</article>')) {
  $name = [regex]::Match($m.Value, 'data-order="([^"]+)"').Groups[1].Value
  if ($name) { $articles += [pscustomobject]@{ Name = $name; Slug = (Slug $name); Html = $m.Value } }
}
if ($articles.Count -eq 0) { throw 'no system cards found in index.html' }

$ugcGrid = [regex]::Match($index, '(?s)<div class="ugc-grid">.*?\n  </div>').Value
$gameGrids = @([regex]::Matches($index, '(?s)<div class="game-grid">\r?\n.*?\r?\n  </div>') | ForEach-Object { $_.Value })
$ownCount = [regex]::Match($index, 'My own games <span class="group-count">(\d+)').Groups[1].Value
$devCount = [regex]::Match($index, 'Worked on as a developer <span class="group-count">(\d+)').Groups[1].Value
if (-not $ugcGrid -or $gameGrids.Count -lt 2) { throw 'UGC or game grids not found in index.html' }

# card markup reused on other pages: no scroll-in animation, order buttons go to the homepage order form
function ForPage([string]$html) {
  $html = $html.Replace(' reveal"', '"')
  # the pages live in folders, so files are linked from the site root
  $html = $html.Replace('src="assets/', 'src="/assets/').Replace('href="assets/', 'href="/assets/')
  [regex]::Replace($html, 'href="#orderForm"([^>]*)data-order="([^"]+)"', {
    param($m) 'href="/?item=' + [uri]::EscapeDataString($m.Groups[2].Value) + '#order"' + $m.Groups[1].Value + 'data-order="' + $m.Groups[2].Value + '"'
  })
}

# ---------- shared page frame ----------
$videoDialog = @'
<dialog class="video-modal" id="videoModal" aria-labelledby="videoTitle">
  <div class="video-head">
    <h3 id="videoTitle">Preview</h3>
    <button type="button" class="video-close" id="videoClose" aria-label="Close preview">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
    </button>
  </div>
  <div class="video-frame"><iframe id="videoFrame" title="System preview video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>
  <a class="video-yt" id="videoYouTube" href="#" target="_blank" rel="noopener">Watch on YouTube</a>
</dialog>
'@

function Page([string]$path, [string]$title, [string]$description, [string]$active, [string]$body, [string]$extraHead, [string]$extraBody) {
  $url = $site + $path
  $nav = ''
  foreach ($link in @(@('/', 'Home'), @('/systems', 'Systems'), @('/ugc', 'UGC'), @('/games', 'Games'), @('/#shop', 'Order &amp; reviews'))) {
    $cls = if ($link[0] -eq $active) { ' class="active" aria-current="page"' } else { '' }
    $nav += '      <li><a href="' + $link[0] + '"' + $cls + '>' + $link[1] + "</a></li>`n"
  }
  $nav += '      <li><a href="/#contact" class="nav-cta">Contact</a></li>'
  $t = Html $title; $d = Html $description
  return @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- made by scripts/build-pages.ps1 from index.html: edit the homepage, then rerun the script -->
<title>$t</title>
<meta name="description" content="$d">
<meta name="theme-color" content="#0a0a0c">
<link rel="canonical" href="$url">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/assets/icon-48.png">
<link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png">
<link rel="apple-touch-icon" href="/assets/icon-192.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="3Iaw">
<meta property="og:url" content="$url">
<meta property="og:title" content="$t">
<meta property="og:description" content="$d">
<meta property="og:image" content="$site/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="$t">
<meta name="twitter:description" content="$d">
<meta name="twitter:image" content="$site/assets/og-image.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
$extraHead
</head>
<body class="subpage">
<header id="siteHeader">
  <div class="brand-wrap">
    <a href="/" class="brand" aria-label="3Iaw home"><img src="/assets/icon-192.png" alt="3Iaw" width="38" height="38"></a>
  </div>
  <button class="nav-toggle" id="navToggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="siteNav"><span></span></button>
  <nav id="siteNav" aria-label="Main">
    <ul>
$nav
    </ul>
  </nav>
</header>

<main>
$body
</main>

<footer>
  <span>&copy; <span id="year">2026</span> 3Iaw &middot; Roblox developer &middot; <a href="/">3iaw.com</a></span>
  <a href="#siteHeader" class="to-top">Back to top
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </a>
</footer>
$extraBody
<script src="/assets/pages.js" defer></script>
</body>
</html>
"@
}

function Crumbs([array]$items) {
  $parts = @('<a href="/">Home</a>')
  for ($i = 0; $i -lt $items.Count; $i++) {
    if ($i -eq $items.Count - 1) { $parts += '<span aria-current="page">' + $items[$i][1] + '</span>' }
    else { $parts += '<a href="' + $items[$i][0] + '">' + $items[$i][1] + '</a>' }
  }
  '<nav class="crumbs" aria-label="Breadcrumb">' + ($parts -join ' <span aria-hidden="true">&rsaquo;</span> ') + '</nav>'
}

$shop = $shopJson | ConvertFrom-Json
$pages = @()
"Building pages from index.html ($($articles.Count) systems)"

# ---------- one page per system ----------
foreach ($a in $articles) {
  $card = ForPage $a.Html
  # the card title becomes the page's main heading
  $card = [regex]::Replace($card, '<h3 class="sys-title"><a href="[^"]*">(.*?)</a></h3>', '<h1 class="sys-title">$1</h1>')
  $intro = PlainText ([regex]::Match($a.Html, '(?s)<div class="sys-body">\s*<p>(.*?)</p>').Groups[1].Value)
  $p = $shop.systems.($a.Name)
  $description = Short ($a.Name + ' for Roblox: ' + $intro) 155
  $others = ($articles | Where-Object { $_.Name -ne $a.Name } | ForEach-Object { '<a class="chip" href="/systems/' + $_.Slug + '">' + (Html $_.Name) + '</a>' }) -join ''
  $nameHtml = Html $a.Name
  $orderUrl = '/?item=' + [uri]::EscapeDataString($a.Name) + '#order'
  $ld = [ordered]@{
    '@context' = 'https://schema.org'; '@type' = 'Product'; 'name' = $a.Name; 'description' = $intro
    'image' = "$site/assets/og-image.png"; 'url' = "$site/systems/$($a.Slug)"; 'category' = 'Roblox game system'
    'brand' = @{ '@type' = 'Brand'; 'name' = '3Iaw' }
    'offers' = @{ '@type' = 'Offer'; 'price' = [string]$p.bdt; 'priceCurrency' = 'BDT'; 'availability' = 'https://schema.org/InStock'; 'url' = "$site/systems/$($a.Slug)" }
  } | ConvertTo-Json -Depth 4 -Compress
  $body = @"
<section class="page-top grid-bg">
  $(Crumbs @(@('/systems', 'Systems'), @('', $nameHtml)))
  <div class="sys-page">
$card
  </div>
</section>

<section id="item-reviews">
  <div class="section-head">
    <div>
      <span class="eyebrow">Reviews</span>
      <h2>What buyers say about the $nameHtml</h2>
    </div>
    <p>Every review comes from a real purchase I have confirmed was paid.</p>
  </div>
  <div class="review-summary" id="reviewSummary" hidden></div>
  <div class="review-grid" id="reviewList" data-item="$nameHtml">
    <p class="review-empty">Loading reviews...</p>
  </div>
  <div class="page-actions">
    <a class="btn btn-solid" href="$orderUrl">Order the $nameHtml</a>
    <a class="btn btn-outline" href="/#review">Leave a review</a>
  </div>
</section>

<section class="more-links">
  <div class="section-head"><div><span class="eyebrow">More systems</span><h2>Other Roblox systems</h2></div></div>
  <div class="skill-cloud">$others</div>
  <div class="page-actions"><a class="btn btn-outline" href="/systems">See all systems</a></div>
</section>
"@
  $pages += @{ Path = "/systems/$($a.Slug)"; Priority = '0.8' }
  Save ("systems\" + $a.Slug + '.html') (Page "/systems/$($a.Slug)" ($a.Name + ' for Roblox | 3Iaw') $description '/systems' $body ('<script type="application/ld+json">' + $ld + '</script>') ($shopScript + "`n" + $videoDialog))
}

# ---------- all systems ----------
$allCards = ($articles | ForEach-Object {
  $c = ForPage $_.Html
  [regex]::Replace($c, '<h3 class="sys-title">(.*?)</h3>', '<h2 class="sys-title">$1</h2>')
}) -join "`n"
$list = ($articles | ForEach-Object { '<a class="chip" href="/systems/' + $_.Slug + '">' + (Html $_.Name) + '</a>' }) -join ''
$body = @"
<section class="page-top grid-bg">
  $(Crumbs (,@('', 'Systems')))
  <div class="section-head">
    <div>
      <span class="eyebrow">Roblox systems</span>
      <h1 class="page-title">Ready-made Roblox systems</h1>
    </div>
    <p>Drop-in systems for hangout and social games, tested and mobile friendly. Pay with Robux, bKash or Nagad and get the system by email.</p>
  </div>
  <div class="skill-cloud page-index">$list</div>
  <div class="sys-grid">
$allCards
  </div>
</section>
"@
$pages += @{ Path = '/systems'; Priority = '0.9' }
Save 'systems.html' (Page '/systems' 'Roblox Systems for Sale: Fly Race, Donation, Kite Fighting & More | 3Iaw' 'Ready-made Roblox systems: Fly Race, Donation, Kite Fighting, Concert Stage, Profile, Partner and more. Pay with Robux, bKash or Nagad.' '/systems' $body '' ($shopScript + "`n" + $videoDialog))

# ---------- custom UGC ----------
$ugc = ForPage $ugcGrid
$body = @"
<section class="page-top grid-bg">
  $(Crumbs (,@('', 'UGC')))
  <div class="section-head">
    <div>
      <span class="eyebrow">Roblox UGC</span>
      <h1 class="page-title">Custom Roblox UGC</h1>
    </div>
    <p>Hats, hair, head wraps, backpacks, crowns and more, made to your idea. Every piece is priced on the work it takes: tell me what you want and I'll send you a quote.</p>
  </div>
  <div class="page-actions page-actions-top">
    <a class="btn btn-solid" href="/#contact">Get a UGC quote</a>
    <a class="btn btn-outline" href="/?item=Custom%20UGC#order">Already chosen? Pay now</a>
  </div>
  <h2 class="group-title"><span class="group-dot own"></span>UGC I've made</h2>
  $ugc
  <p class="games-note">Tap a poster to see it full size.</p>
</section>

<section class="more-links">
  <div class="section-head">
    <div><span class="eyebrow">How it works</span><h2>Ordering custom UGC</h2></div>
  </div>
  <ol class="order-steps">
    <li><b>Tell me your idea</b> Send a message with what you want, a reference picture if you have one.</li>
    <li><b>Get a quote</b> I reply with the price for the work it takes.</li>
    <li><b>Pay with bKash or Nagad</b> Choose "Custom UGC (already chosen)" in the order form and enter the agreed price.</li>
    <li><b>Get your UGC, then review it</b> Once your payment is confirmed I send it to you, and you can leave a review with your order ID.</li>
  </ol>
</section>
"@
$pages += @{ Path = '/ugc'; Priority = '0.8' }
Save 'ugc.html' (Page '/ugc' 'Custom Roblox UGC: Hats, Hair, Accessories | 3Iaw' 'Custom Roblox UGC made to your idea: hats, hair, head wraps, backpacks, crowns and more. Priced on the work it takes. Pay with bKash or Nagad.' '/ugc' $body '' '')

# ---------- games ----------
$body = @"
<section class="page-top grid-bg">
  $(Crumbs (,@('', 'Games')))
  <div class="section-head">
    <div>
      <span class="eyebrow">Roblox games</span>
      <h1 class="page-title">Roblox games I've made and worked on</h1>
    </div>
    <p>My own Roblox games, and the games I work on as a developer. Visits, names and pictures update live from Roblox.</p>
  </div>
  <h2 class="group-title"><span class="group-dot own"></span>My own games <span class="group-count">$ownCount</span></h2>
  $(ForPage $gameGrids[0])
  <h2 class="group-title"><span class="group-dot"></span>Worked on as a developer <span class="group-count">$devCount</span></h2>
  $(ForPage $gameGrids[1])
  <p class="games-note"><span id="statsNote">Visit counts as of $((Get-Date).ToString('MMMM yyyy')).</span></p>
</section>
"@
$pages += @{ Path = '/games'; Priority = '0.8' }
Save 'games.html' (Page '/games' 'Roblox Games by 3Iaw: Bangali Hood, Bangla Town & More' 'Roblox games by 3Iaw: Bangali Era, Ondhokar, CTG CITY and Bangla Beach Hangout, plus developer work on Bangali Hood, Bangla Town, Mystic Hangout and more.' '/games' $body '' '')

# ---------- sitemap ----------
$ugcImages = ([regex]::Matches($ugcGrid, 'href="(assets/ugc/[^"]+\.png)"') | ForEach-Object { "    <image:image><image:loc>$site/$($_.Groups[1].Value)</image:loc></image:image>" }) -join "`n"
$urls = @("  <url>`n    <loc>$site/</loc>`n    <lastmod>$today</lastmod>`n    <changefreq>weekly</changefreq>`n    <priority>1.0</priority>`n    <image:image><image:loc>$site/assets/og-image.png</image:loc></image:image>`n  </url>")
foreach ($pg in $pages) {
  $img = if ($pg.Path -eq '/ugc') { "`n" + $ugcImages } else { '' }
  $urls += "  <url>`n    <loc>$site$($pg.Path)</loc>`n    <lastmod>$today</lastmod>`n    <changefreq>weekly</changefreq>`n    <priority>$($pg.Priority)</priority>$img`n  </url>"
}
Save 'sitemap.xml' ("<?xml version=`"1.0`" encoding=`"UTF-8`"?>`n<!-- made by scripts/build-pages.ps1; the admin page and /api are left out on purpose -->`n<urlset xmlns=`"http://www.sitemaps.org/schemas/sitemap/0.9`" xmlns:image=`"http://www.google.com/schemas/sitemap-image/1.1`">`n" + ($urls -join "`n") + "`n</urlset>`n")
"Done: $($pages.Count + 1) pages in the sitemap"
