// English / Bangla for the Audio Converter (/audio). The page is written in English; with Bangla on,
// every text node, placeholder and a few rich blocks are swapped, and anything the converter writes
// later is translated as it appears (a MutationObserver). English is restored from the originals.

const WORDS = {
  // sidebar, header, account menu
  'Audio Converter': 'অডিও কনভার্টার',
  'Convert Audio': 'অডিও কনভার্ট',
  'History': 'ইতিহাস',
  'Tutorial': 'টিউটোরিয়াল',
  'Roblox Account': 'Roblox অ্যাকাউন্ট',
  'Log in with Discord': 'Discord দিয়ে লগ ইন',
  'Discord login coming soon': 'Discord লগ ইন শীঘ্রই আসছে',
  'Log out': 'লগ আউট',
  'Logout': 'লগ আউট',
  'Log in': 'লগ ইন',
  // welcome + cards
  'Welcome': 'স্বাগতম',
  'Convert audio and upload it to your Roblox account. Everything is processed in your own browser.': 'অডিও কনভার্ট করে আপনার Roblox অ্যাকাউন্টে আপলোড করুন। সব কাজ আপনার নিজের ব্রাউজারেই হয়।',
  'Discord account': 'Discord অ্যাকাউন্ট',
  'Roblox account': 'Roblox অ্যাকাউন্ট',
  'Total conversions': 'মোট কনভার্শন',
  'Current plan': 'বর্তমান প্ল্যান',
  'Not linked': 'লিংক করা হয়নি',
  'not linked': 'লিংক করা হয়নি',
  'Linked': 'লিংক করা',
  'Connect': 'কানেক্ট',
  'Not connected': 'কানেক্ট করা হয়নি',
  'Connect Roblox': 'Roblox কানেক্ট করুন',
  'Coming soon': 'শীঘ্রই আসছে',
  'Free': 'ফ্রি',
  'Unlimited': 'আনলিমিটেড',
  'Upgrade plan': 'প্ল্যান আপগ্রেড',
  'Upgrade': 'আপগ্রেড',
  'Unlimited uploads': 'আনলিমিটেড আপলোড',
  'Free plan': 'ফ্রি প্ল্যান',
  '2 free uploads': '২টি ফ্রি আপলোড',
  // convert
  'Convert audio': 'অডিও কনভার্ট',
  'Source': 'সোর্স',
  'Sound': 'সাউন্ড',
  'Upload': 'আপলোড',
  'Presets': 'প্রিসেট',
  'Drop an audio file here': 'এখানে একটি অডিও ফাইল দিন',
  'or click to choose one · MP3, WAV, OGG, M4A, FLAC or a video file': 'অথবা ক্লিক করে বেছে নিন · MP3, WAV, OGG, M4A, FLAC বা ভিডিও ফাইল',
  'Only upload audio you made or have permission to use. Roblox removes audio that breaks its copyright rules and can moderate your account.': 'শুধু নিজের বানানো বা অনুমতি আছে এমন অডিও আপলোড করুন। কপিরাইট নিয়ম ভাঙলে Roblox অডিও সরিয়ে দেয় এবং আপনার অ্যাকাউন্টে ব্যবস্থা নিতে পারে।',
  'Slow': 'স্লো', 'Default': 'ডিফল্ট', 'Fast': 'ফাস্ট', 'Faster': 'আরও ফাস্ট', 'Ultra': 'আল্ট্রা',
  'Speed': 'স্পিড',
  'Amplify (dB)': 'ভলিউম (dB)',
  'Amplify': 'ভলিউম',
  'Max Duration (seconds)': 'সর্বোচ্চ সময় (সেকেন্ড)',
  'Hide': 'লুকান',
  'Edit': 'এডিট',
  'Start at (seconds)': 'শুরু (সেকেন্ড)',
  'Crop': 'ক্রপ',
  'Play selection': 'বাছাই করা অংশ শুনুন',
  'Stop': 'থামান',
  'Start': 'শুরু',
  'End': 'শেষ',
  'Reset': 'রিসেট',
  'Reading the audio…': 'অডিও পড়া হচ্ছে…',
  "This file can't be previewed here, so it will be converted from the start.": 'এই ফাইলটি এখানে দেখানো যাচ্ছে না, তাই শুরু থেকে কনভার্ট হবে।',
  'Nothing left to convert in the cropped part.': 'ক্রপ করা অংশে কনভার্ট করার মতো কিছু নেই।',
  'Name on Roblox': 'Roblox-এ নাম',
  'from the file name': 'ফাইলের নাম থেকে',
  "Upload to Roblox when it's converted": 'কনভার্ট হলে Roblox-এ আপলোড করুন',
  'Convert': 'কনভার্ট',
  'Moderation': 'মডারেশন',
  'Convert & upload': 'কনভার্ট ও আপলোড',
  'Convert only': 'শুধু কনভার্ট',
  'Choose an audio file first.': 'আগে একটি অডিও ফাইল বেছে নিন।',
  // history
  'Conversion History': 'কনভার্শন ইতিহাস',
  'Track all your audio conversions and uploads. Statuses refresh on their own.': 'আপনার সব অডিও কনভার্শন ও আপলোড দেখুন। স্ট্যাটাস নিজে থেকেই আপডেট হয়।',
  'All': 'সব', 'Approved': 'অনুমোদিত', 'Reviewing': 'রিভিউ চলছে', 'Failed': 'ব্যর্থ',
  'In review': 'রিভিউতে', 'Rejected': 'বাতিল', 'Not uploaded': 'আপলোড হয়নি', 'Waiting': 'অপেক্ষায়',
  'Review': 'রিভিউ', 'In game': 'গেমে',
  'Copy link': 'লিংক কপি', 'Download MP3': 'MP3 ডাউনলোড', 'Check status': 'স্ট্যাটাস দেখুন',
  'Remove': 'সরান', 'Upload to Roblox': 'Roblox-এ আপলোড',
  'Details': 'বিস্তারিত', 'Asset': 'অ্যাসেট', 'Date': 'তারিখ', 'Output': 'আউটপুট', 'File': 'ফাইল',
  '· approved': '· অনুমোদিত', '· in review': '· রিভিউতে', '· rejected': '· বাতিল',
  'just now': 'এইমাত্র',
  'No audio yet. Choose a file in Convert to start.': 'এখনও কোনো অডিও নেই। শুরু করতে কনভার্টে একটি ফাইল বেছে নিন।',
  'Nothing here with this filter.': 'এই ফিল্টারে কিছু নেই।',
  'This list is saved in this browser only. Converted files stay until you close or reload the page, so download them if you want to keep them.': 'এই তালিকা শুধু এই ব্রাউজারে সেভ থাকে। পেজ বন্ধ বা রিলোড করলে কনভার্ট করা ফাইল চলে যায়, তাই রাখতে চাইলে ডাউনলোড করে নিন।',
  // accounts & plan
  'Accounts & Plan': 'অ্যাকাউন্ট ও প্ল্যান',
  'Link your creator account and manage your plan.': 'আপনার ক্রিয়েটর অ্যাকাউন্ট লিংক করুন এবং প্ল্যান ম্যানেজ করুন।',
  'Not logged in': 'লগ ইন করা হয়নি',
  'Discord Account': 'Discord অ্যাকাউন্ট',
  'Plan': 'প্ল্যান',
  'This month': 'এই মাসে',
  'Uploaded to Roblox': 'Roblox-এ আপলোড',
  'Personal Account': 'পার্সোনাল অ্যাকাউন্ট',
  'Group Account': 'গ্রুপ অ্যাকাউন্ট',
  'Create API key on Roblox Creator Hub': 'Roblox Creator Hub-এ API key বানান',
  'Username or user ID': 'ইউজারনেম বা ইউজার আইডি',
  'Group ID': 'গ্রুপ আইডি',
  'username, ID or profile link': 'ইউজারনেম, আইডি বা প্রোফাইল লিংক',
  'group ID or group link': 'গ্রুপ আইডি বা গ্রুপ লিংক',
  'paste to set or replace': 'সেট বা বদলাতে পেস্ট করুন',
  'Remember on this device': 'এই ডিভাইসে মনে রাখুন',
  'The key is kept in this browser and sent to Roblox (through 3iaw.com) only when you upload or check a status. 3iaw.com never stores it.': 'Key শুধু এই ব্রাউজারে থাকে, আর আপলোড বা স্ট্যাটাস দেখার সময়ই (3iaw.com হয়ে) Roblox-এ যায়। 3iaw.com কখনও এটা সেভ করে না।',
  'Forget key': 'Key মুছুন',
  'Back to convert': 'কনভার্টে ফিরুন',
  'Save': 'সেভ',
  'Every Discord account gets 2 free uploads to Roblox. A plan gives unlimited uploads. Converting and downloading are always free.': 'প্রতিটি Discord অ্যাকাউন্ট Roblox-এ ২টি ফ্রি আপলোড পায়। প্ল্যান নিলে আনলিমিটেড আপলোড। কনভার্ট ও ডাউনলোড সবসময় ফ্রি।',
  'Your plan is active': 'আপনার প্ল্যান চালু আছে',
  'You can buy another plan when this one ends.': 'এই প্ল্যান শেষ হলে নতুন প্ল্যান কিনতে পারবেন।',
  'Get a plan': 'প্ল্যান নিন',
  '1 Month': '১ মাস', '3 Months': '৩ মাস', '1 Year': '১ বছর',
  '30 days of unlimited uploads': '৩০ দিন আনলিমিটেড আপলোড',
  'Pay with': 'পেমেন্ট মাধ্যম',
  'Transaction ID': 'ট্রানজেকশন আইডি',
  'Email': 'ইমেইল',
  'from your receipt': 'রিসিট থেকে',
  'for your receipt': 'রিসিটের জন্য',
  'Place order': 'অর্ডার করুন',
  'Log in with Discord to buy': 'কিনতে Discord দিয়ে লগ ইন করুন',
  'Your plan starts when the payment is confirmed, usually within a few hours.': 'পেমেন্ট কনফার্ম হলে প্ল্যান শুরু হয়, সাধারণত কয়েক ঘণ্টার মধ্যে।',
  'Copy': 'কপি',
  // tutorial
  'How to use the converter': 'কনভার্টার কীভাবে ব্যবহার করবেন',
  'From an audio file to a sound playing in your Roblox game.': 'অডিও ফাইল থেকে আপনার Roblox গেমে সাউন্ড বাজানো পর্যন্ত।',
  'Video coming soon': 'ভিডিও শীঘ্রই আসছে',
  'Step by step': 'ধাপে ধাপে',
  // toasts
  'Logged out': 'লগ আউট হয়েছে',
  'Link copied': 'লিংক কপি হয়েছে',
  'Asset ID copied': 'অ্যাসেট আইডি কপি হয়েছে',
  'Key removed from this browser': 'এই ব্রাউজার থেকে Key মুছে ফেলা হয়েছে',
  'Logged in with Discord': 'Discord দিয়ে লগ ইন হয়েছে',
};

const UNITS = { minute: 'মিনিট', hour: 'ঘণ্টা', day: 'দিন' };
const PATTERNS = [
  [/^(\d+) of (\d+) free uploads left$/, (m) => `${m[2]}টির মধ্যে ${m[1]}টি ফ্রি আপলোড বাকি`],
  [/^\/(\d+) free uploads left$/, (m) => `/${m[1]} ফ্রি আপলোড বাকি`],
  [/^(\d+) this month$/, (m) => `এই মাসে ${m[1]}`],
  [/^Until (.+)$/, (m) => `${m[1]} পর্যন্ত`],
  [/^Your plan runs until (.+)$/, (m) => `আপনার প্ল্যান ${m[1]} পর্যন্ত`],
  [/^Unlimited uploads until (.+)\.$/, (m) => `${m[1]} পর্যন্ত আনলিমিটেড আপলোড।`],
  [/^Unlimited until (.+)$/, (m) => `${m[1]} পর্যন্ত আনলিমিটেড`],
  [/^(\d+) of (\d+) free uploads$/, (m) => `${m[2]}টির মধ্যে ${m[1]}টি ফ্রি আপলোড`],
  [/^(\d+) (minute|hour|day)s? ago$/, (m) => `${m[1]} ${UNITS[m[2]]} আগে`],
  [/^Connected: (.+)$/, (m) => `কানেক্টেড: ${m[1]}`],
  [/^Max Duration: (\d+)s$/, (m) => `সর্বোচ্চ সময়: ${m[1]}s`],
];

// blocks with links or bold text inside: swapped as a whole
const BLOCKS = [
  ['.ac-guide li:nth-child(1)', 'খুলুন <a href="https://create.roblox.com/dashboard/credentials" target="_blank" rel="noopener">create.roblox.com &rarr; Credentials</a> এবং একটি API key বানান।'],
  ['.ac-guide li:nth-child(2)', '<b>Assets</b> API যোগ করুন, <b>Read</b> ও <b>Write</b> সহ।'],
  ['.ac-guide li:nth-child(3)', 'Accepted IP Addresses-এ <code>0.0.0.0/0</code> দিন। আপলোড আপনার পিসি থেকে নয়, 3iaw.com-এর সার্ভার থেকে যায়, তাই এটা লাগবে।'],
  ['.ac-guide li:nth-child(4)', 'সেভ করুন, তারপর key কপি করে নিচে পেস্ট করুন।'],
  ['.ac-steps-list li:nth-child(1)', '<b>Discord দিয়ে লগ ইন করুন</b><span>আপনার অ্যাকাউন্ট ২টি ফ্রি আপলোড পায়। প্ল্যান নিলে আনলিমিটেড আপলোড।</span>'],
  ['.ac-steps-list li:nth-child(2)', '<b>Roblox কানেক্ট করুন</b><span>Assets read ও write সহ একটি Open Cloud API key বানিয়ে Roblox অ্যাকাউন্টে পেস্ট করুন।</span>'],
  ['.ac-steps-list li:nth-child(3)', '<b>অডিও বেছে নিন</b><span>নিজের বানানো বা অনুমতি আছে এমন অডিও, অথবা Roblox-এর নিজস্ব অডিও লাইব্রেরির ট্র্যাক ব্যবহার করুন।</span>'],
  ['.ac-steps-list li:nth-child(4)', '<b>একটি প্রিসেট বেছে নিন</b><span>ডিফল্ট সাউন্ড যেমন আছে তেমনই রাখে। দরকার হলে স্পিড, ভলিউম ও সর্বোচ্চ সময় বদলান।</span>'],
  ['.ac-steps-list li:nth-child(5)', '<b>কনভার্ট ও আপলোড</b><span>অডিও আপনার অ্যাকাউন্টে যায় এবং Roblox রিভিউ করে। ইতিহাসে স্ট্যাটাস দেখুন।</span>'],
  ['.ac-steps-list li:nth-child(6)', '<b>গেমে ব্যবহার করুন</b><span>অনুমোদিত হলে লিংক বা আইডি কপি করে Roblox Studio-তে Sound-এর SoundId হিসেবে দিন।</span>'],
  ['#payBox p', '<b id="payAmount"></b> <b id="payMethod"></b> Send Money দিয়ে এই নম্বরে পাঠান, তারপর নিচে ট্রানজেকশন আইডি দিন।'],
];

let lang = 'en';
try { lang = localStorage.getItem('ac.lang') === 'bn' ? 'bn' : 'en'; } catch {}
const orig = new Map();        // text node -> its English text
const origAttr = new Map();    // element -> {placeholder}
const origBlock = new Map();   // element -> English innerHTML
let busy = false;

function bnFor(en) {
  const t = en.trim();
  if (!t) return null;
  let out = WORDS[t];
  if (out === undefined) for (const [re, fn] of PATTERNS) { const m = t.match(re); if (m) { out = fn(m); break; } }
  if (out === undefined) return null;
  return en.replace(t, out); // keep the spaces around it
}
function translateNode(n) {
  if (n.nodeType !== 3 || !n.nodeValue.trim()) return;
  const p = n.parentElement;
  if (!p || p.closest('script,style,code,[data-no-i18n]')) return;
  const cur = n.nodeValue;
  if (orig.has(n) && bnFor(orig.get(n)) === cur) return; // already ours
  const bn = bnFor(cur);
  if (bn === null) { orig.delete(n); return; }
  orig.set(n, cur);
  n.nodeValue = bn;
}
function translateTree(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) translateNode(n);
  root.querySelectorAll?.('[placeholder]').forEach(translatePh);
}
function translatePh(el) {
  const cur = el.placeholder;
  if (origAttr.has(el) && bnFor(origAttr.get(el)) === cur) return; // already ours
  const bn = bnFor(cur);
  if (bn === null) { origAttr.delete(el); return; }
  origAttr.set(el, cur);
  el.placeholder = bn;
}
function swapBlocks(on) {
  for (const [sel, html] of BLOCKS) {
    document.querySelectorAll(sel).forEach((el) => {
      if (on) {
        if (origBlock.has(el)) return;
        // keep live values (the amount and method on the payment line) across the swap
        const keep = [...el.querySelectorAll('[id]')].map((x) => [x.id, x.textContent]);
        origBlock.set(el, el.innerHTML);
        el.innerHTML = html;
        keep.forEach(([id, t]) => { const x = el.querySelector('#' + id); if (x) x.textContent = t; });
      } else if (origBlock.has(el)) {
        const keep = [...el.querySelectorAll('[id]')].map((x) => [x.id, x.textContent]);
        el.innerHTML = origBlock.get(el);
        keep.forEach(([id, t]) => { const x = el.querySelector('#' + id); if (x) x.textContent = t; });
        origBlock.delete(el);
      }
    });
  }
}
const roots = () => [document.querySelector('.ac-console'), document.querySelector('#acHdr'), document.querySelector('#toast')].filter(Boolean);
const observer = new MutationObserver((list) => {
  if (lang !== 'bn' || busy) return;
  busy = true;
  for (const m of list) {
    if (m.type === 'characterData') translateNode(m.target);
    if (m.type === 'attributes') translatePh(m.target);
    m.addedNodes.forEach((n) => (n.nodeType === 3 ? translateNode(n) : n.nodeType === 1 && translateTree(n)));
  }
  busy = false;
});

function loadFont() {
  if (document.getElementById('bnFont')) return;
  const l = document.createElement('link');
  l.id = 'bnFont'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap';
  document.head.appendChild(l);
}

export function setLang(next) {
  lang = next === 'bn' ? 'bn' : 'en';
  try { localStorage.setItem('ac.lang', lang); } catch {}
  document.documentElement.lang = lang === 'bn' ? 'bn' : 'en';
  document.documentElement.classList.toggle('lang-bn', lang === 'bn');
  document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
  busy = true;
  if (lang === 'bn') {
    loadFont();
    swapBlocks(true);
    roots().forEach(translateTree);
  } else {
    swapBlocks(false);
    orig.forEach((en, n) => { if (n.isConnected) n.nodeValue = en; });
    orig.clear();
    origAttr.forEach((en, el) => { el.placeholder = en; });
    origAttr.clear();
  }
  busy = false;
}
export function getLang() { return lang; }
export function startI18n() {
  roots().forEach((r) => observer.observe(r, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder'] }));
  if (lang === 'bn') setLang('bn');
  else document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === 'en'));
}
