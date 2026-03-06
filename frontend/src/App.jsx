import { useState, useEffect, useCallback, createContext, useContext, useRef } from "react";

/* ─── API helpers ─── */
const apiFetch = async (path, opts = {}) => {
  const res = await fetch(path, { credentials: "include", ...opts });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = Array.isArray(e.detail) ? e.detail.map(d=>d.msg||d).join(", ") : (e.detail || res.statusText);
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
};
const copyToClipboard = async (text) => {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(el);
  el.focus(); el.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(el);
};
const fmtBytes = b => { if (!b) return "0 B"; const u=["B","KB","MB","GB","TB"]; const i=Math.floor(Math.log(b)/Math.log(1024)); return `${(b/Math.pow(1024,i)).toFixed(1)} ${u[i]}`; };
const fmtEta = s => { if (s<=0) return "—"; if (s<60) return `${s}s`; if (s<3600) return `${Math.floor(s/60)}m ${s%60}s`; return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`; };
const wsToTorrent = t => ({
  id: t.info_hash, info_hash: t.info_hash, name: t.name,
  size: fmtBytes(t.total_size),
  doneBytes: t.total_done||0, totalBytes: t.total_size||0,
  downSpeed: t.download_rate||0, upSpeed: t.upload_rate||0,
  seeds: t.num_seeds||0, peers: t.num_peers||0,
  status: t.state||"queued", progress: t.progress||0,
  destination: t.destination||"local", eta: fmtEta(t.eta),
  added: t.added_at ? t.added_at.split("T")[0] : "", ratio: t.ratio||0,
  category: t.category||"",
  torLimDl: t.download_limit||0, torLimUl: t.upload_limit||0,
});

/* ─── Force dark on html/body (fixes white iframe in preview) ─── */
const injectDark = () => {
  try {
    if (typeof document === "undefined") return;
    const id = "bittora-dark";
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = "html,body,#root,[data-reactroot]{background:#080a12!important;color:#e5e7eb!important;margin:0;padding:0;min-height:100vh;min-height:100dvh}*{scrollbar-width:thin;scrollbar-color:#1e2235 transparent;box-sizing:border-box}::selection{background:rgba(139,92,246,.3)}input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield;appearance:textfield}@media(max-width:768px){input,select,textarea{font-size:16px!important}body{-webkit-text-size-adjust:100%}}@keyframes bSlideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}@keyframes bSlideOut{from{transform:translateX(0);opacity:1}to{transform:translateX(120%);opacity:0}}@keyframes toastDropIn{from{transform:translateY(-12px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes toastFadeOut{from{opacity:1}to{opacity:0}}@keyframes detailFadeIn{from{opacity:0}to{opacity:1}}@keyframes detailSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}@keyframes detailPopIn{from{opacity:0;transform:scale(0.94)}to{opacity:1;transform:scale(1)}}";
    document.head.appendChild(s);
    document.documentElement.style.background = "#080a12";
    document.body.style.background = "#080a12";
    document.body.style.margin = "0";
  } catch(e){}
};

/* ─── Font Awesome ─── */
const loadFA = () => { try { const u="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"; if(typeof document!=="undefined"&&!document.querySelector(`link[href="${u}"]`)){const l=document.createElement("link");l.rel="stylesheet";l.href=u;document.head.appendChild(l);} }catch(e){} };

const I = ({n,c="",...p}) => <i className={`${n} ${c}`} {...p}/>;

/* ─── Colors ─── */
const C = { bg:"#080a12", card:"rgba(19,21,42,0.9)", border:"rgba(255,255,255,0.06)", borderL:"rgba(255,255,255,0.08)", text:"#e5e7eb", dim:"#9ca3af", muted:"#6b7280", vio:"#7c3aed", vioL:"#8b5cf6", ind:"#4f46e5", em:"#10b981", red:"#ef4444", amb:"#f59e0b" };
const glass = {background:`linear-gradient(135deg,${C.card},rgba(13,15,26,0.9))`,border:`1px solid ${C.border}`,borderRadius:16,backdropFilter:"blur(20px)"};
const sInp = {background:"rgba(255,255,255,0.04)",border:`1px solid ${C.borderL}`,borderRadius:12,padding:"10px 12px",fontSize:14,color:C.text,outline:"none",width:"100%",boxSizing:"border-box"};
const sInpI = {...sInp,paddingLeft:40};
const sBtn = {background:`linear-gradient(135deg,${C.vio},${C.ind})`,color:"#fff",border:"none",borderRadius:12,padding:"12px 24px",fontSize:14,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8};
const sGhost = {background:"transparent",color:C.dim,border:"none",borderRadius:12,padding:"10px 16px",fontSize:14,cursor:"pointer"};

/* ═══════════════ LOCALIZATION ═══════════════ */
const SK = {
  loginTitle:"Prihláste sa do svojho účtu", loginUser:"Používateľ", loginPass:"Heslo", loginBtn:"Prihlásiť sa", loginLoading:"Prihlasujem...", loginError:"Nesprávne prihlasovacie údaje",
  loginInfo:"Predvolené údaje:", loginInfoSub:"Pri prvom prihlásení budete vyzvaní na zmenu hesla",
  changeTitle:"Nastavte si nové heslo pre admin účet", changeWarn:"Bezpečnostné opatrenie", changeWarnText:"Predvolené heslo nie je bezpečné. Nastavte si nové heslo.",
  newPass:"Nové heslo", newPassPh:"Zadajte nové heslo", confirmPass:"Potvrdenie hesla", confirmPassPh:"Zopakujte nové heslo",
  changeBtn:"Nastaviť heslo a pokračovať", saving:"Ukladám...", passShort:"Heslo musí mať aspoň 4 znaky", passNoMatch:"Heslá sa nezhodujú",
  weak:"Slabé", avg:"Priemerné", good:"Dobré", strong:"Silné", vstrong:"Veľmi silné",
  search:"Hľadať torrenty...", add:"Pridať",
  fAll:"Všetky", fDown:"Sťahovanie", fDone:"Dokončené", fPause:"Pozastavené", fQueue:"V rade", cats:"Kategórie",
  disk:"Miesto na disku", free:"voľných", occ:"obsadených",
  dl:"Download", ul:"Upload", active:"Aktívne", done:"Dokončené",
  sel:"vybratých", pause:"Pauza", resume:"Obnoviť", remove:"Odstrániť",
  name:"Názov", status:"Stav", progress:"Progres", speed:"Rýchlosť", sp:"S/P", dest:"Cieľ", eta:"ETA",
  noTor:"Žiadne torrenty", noTorH:"Pridajte torrenty tlačidlom vyššie",
  stD:"Sťahovanie", stC:"Hotové", stP:"Pauza", stQ:"V rade", stE:"Chyba",
  dLocal:"Lokálne", dFTP:"FTP", dSMB:"SMB",
  info:"Info", files:"Súbory", peers:"Peers", trackers:"Trackery",
  downloaded:"Stiahnuté", speedD:"Rýchlosť ↓", speedU:"Rýchlosť ↑", ratio:"Ratio", cat:"Kategória",
  settings:"Nastavenia", save:"Uložiť", cancel:"Zrušiť", saved:"Nastavenia uložené",
  sGen:"Všeobecné", sNet:"Sieť", sDl:"Sťahovanie", sStor:"Úložiská", sRss:"RSS kanály", sSched:"Plánovač", sWh:"Webhook", sUsers:"Používatelia", sSec:"Zabezpečenie", sLog:"Logy", sAbout:"O aplikácii",
  logTitle:"Systémové logy", logEmpty:"Žiadne logy", logRefresh:"Obnoviť",
  webIface:"Webové rozhranie", appPort:"Port aplikácie", appPortS:"Port na ktorom bude Bittora dostupná", availAt:"Dostupná na",
  ui:"Rozhranie", darkMode:"Tmavý režim", darkModeS:"Tmavý vzhľad", toast:"Toast notifikácie", toastS:"Push notifikácie", sound:"Zvukové upozornenia", soundS:"Zvuk pri dokončení", lang:"Jazyk",
  behavior:"Správanie", autoStart:"Automatický štart", autoStartS:"Okamžite stiahnuť po pridaní", confirmDel:"Potvrdiť odstránenie", confirmDelS:"Potvrdenie pred zmazaním",
  speedSec:"Rýchlosť", maxDL:"Max. download", maxUL:"Max. upload", maxGlob:"Max. globálnych pripojení", maxPer:"Max. pripojení/torrent", unlim:"0 = neobmedzené",
  portProto:"Port & protokol", listenPort:"Počúvací port", upnp:"UPnP / NAT-PMP", upnpS:"Auto presmerovanie portov", utp:"uTP", utpS:"Micro Transport Protocol",
  dhtSec:"DHT & Discovery", dht:"DHT", dhtS:"Distributed Hash Table", pex:"PEX", pexS:"Peer Exchange", lpd:"Local Peer Discovery", lpdS:"LAN peers",
  proxy:"Proxy", proxyType:"Typ proxy", proxyNone:"Žiadny",
  limits:"Limity", maxActDL:"Max. aktívnych sťahovaní", maxActSeed:"Max. aktívnych seedovaní", maxTot:"Max. celkovo",
  seeding:"Seeding", targetRatio:"Cieľový ratio", maxSeedTime:"Max. čas seedovania", autoSeed:"Auto-seed po dokončení",
  prio:"Prioritizácia", seqDl:"Sekvenčné sťahovanie", seqDlS:"Sťahovať postupne", flPiece:"First/Last piece", flPieceS:"Priorita prvého a posledného kusu",
  defStorage:"Predvolené úložisko", defStorDesc:"Predvolené úložisko pre nové torrenty", extConn:"Externé pripojenia", lastTest:"Naposledy testované", online:"Online", offline:"Offline",
  ftpPathRequired:"Vzdialená cesta je povinná pre upload", connUpdated:"Pripojenie aktualizované",
  rssFeeds:"RSS kanály", addRss:"Pridať RSS kanál", autoDl:"Automatické sťahovanie", autoDlM:"Auto-sťahovať zhody", autoDlS:"Torrenty zodpovedajúce filtrom", checkInt:"Interval kontroly", matches:"zhôd",
  schedTitle:"Plánovač rýchlosti", schedEn:"Aktivovať plánovač", schedEnS:"Obmedziť rýchlosť podľa rozvrhu", altLim:"Alt. limity", altDL:"Alt. download", altUL:"Alt. upload", full:"Plná", limited:"Obmedzená",
  whEn:"Aktivovať webhook", whEnS:"HTTP notifikácie (Home Assistant, Node-RED...)", whEnd:"Endpoint", whAcc:"Prístup",
  whPub:"Verejný", whPubS:"Bez autentifikácie", whPass:"S heslom", whPassS:"Vyžaduje API kľúč",
  whKey:"API kľúč", whGen:"Gen.", whKeyGen:"API kľúč vygenerovaný", whEvt:"Udalosti",
  whAdded:"Torrent pridaný", whProg:"Zmena progresu", whComp:"Dokončené", whErr:"Chyba", whRem:"Odstránený",
  whPayload:"Payload ukážka", whInteg:"Home Assistant / Node-RED / IFTTT", urlCop:"URL skopírovaná",
  userMgmt:"Správa používateľov", fullPerm:"Plné oprávnenia", limPerm:"Obmedzené oprávnenia",
  pDl:"Sťahovanie", pDlS:"Môže sťahovať", pUl:"Upload", pUlS:"Môže pridávať torrenty", pExt:"Externé úložisko", pExtS:"Môže používať FTP/SMB", pWh:"Webhook", pWhS:"Prístup k webhook",
  perms:"Oprávnenia", addUsr:"Pridať používateľa", newUsr:"Nový používateľ", create:"Vytvoriť",
  usrName:"Meno", usrCreated:"vytvorený", usrRemoved:"Používateľ odstránený", usrExists:"Používateľ už existuje", fillBoth:"Vyplňte meno a heslo",
  secAcc:"Prístup", reqLogin:"Vyžadovať prihlásenie", reqLoginS:"Prístup len po overení",
  sessTimeout:"Timeout sedenia", sessTimeoutS:"Auto-odhlásenie", encrypt:"Šifrovanie", forceEnc:"Vynútiť šifrovanie", forceEncS:"Vyžadovať šifrované pripojenia",
  anon:"Anonymný režim", anonS:"Neodosielať identifikáciu", ipFilt:"IP filtre", enIpFilt:"Aktivovať IP filtre", enIpFiltS:"Blokovať škodlivé IP",
  torLim:"Limity torrenta", globLimActive:"Globálne limity aktívne", limSaved:"Limity uložené",
  built:"FastAPI + libtorrent + React", wsRT:"WebSocket real-time",
  tPaused:"pozastavených", tResumed:"obnovených", tRemoved:"odstránených", tDone:"dokončené!", tAdded:"torrent(ov) pridaných",
  addTorrent:"Pridať torrent", addMagnet:"Magnet link", addFile:"Torrent súbor",
  magnetPh:"Vložte magnet link(y), jeden na riadok", dropzone:"Pretiahnite .torrent súbory sem",
  browse:"Prehľadávať", startNow:"Spustiť ihneď", addBtn:"Pridať", selCat:"Kategória",
  noCat:"Bez kategórie", selDest:"Cieľové úložisko", filesSelected:"súborov",
  sCats:"Kategórie", catMgmt:"Správa kategórií", addCat:"Pridať", catName:"Názov", catNamePh:"napr. Filmy, Hudba...", noCatYet:"Zatiaľ žiadne kategórie", catColor:"Farba",
  extStorage:"Externé úložiská", addFtp:"Pridať FTP", addSmb:"Pridať SMB", noExtConn:"Žiadne externé úložiská", noExtConnH:"Pridajte FTP alebo SMB úložisko tlačidlom nižšie", host:"Server", connPort:"Port", connUser:"Používateľ", connPass:"Heslo", remotePath:"Vzdialená cesta", share:"Zdieľaná zložka", connName:"Názov pripojenia", addConn:"Pridať", connAdded:"Úložisko pridané", connRemoved:"Úložisko odstránené", ftpNamePh:"Môj FTP server", smbNamePh:"Môj SMB server", actBadge:"AKTÍVNE", connTest:"Testovať", connOnline:"Pripojenie úspešné", connOffline:"Pripojenie zlyhalo", connTesting:"Testujem...", noMagnets:"Žiadne platné magnet linky", addError:"Chyba pri pridávaní",
  sAcc:"Účet", accRoleAdmin:"Administrátor", accRoleUser:"Používateľ", curPass:"Aktuálne heslo", curPassPh:"Zadajte aktuálne heslo", accSaved:"Heslo bolo zmenené", accChPass:"Zmeniť heslo",
  filters:"Filtre", delTitle:"Odstrániť torrent", delOptList:"Len odstrániť z listu", delOptListS:"Stiahnuté súbory zostanú na disku", delOptFiles:"Zmazať aj súbory", delOptFilesS:"Natrvalo zmaže stiahnuté/neúplné súbory", torrentsCnt:"torrentov",
  addTrackers:"Trackery (voliteľné)", trackersPh:"URL trackera, jeden na riadok",
  portRestartNote:"Zmena portu vyžaduje reštart služby Bittora",
  noSslNote:"Aplikácia beží cez HTTP (bez SSL). Webhook URL bude tiež HTTP.",
  whOutUrl:"Odchádzajúci webhook URL", logout:"Odhlásiť sa",
  rssUrl:"URL kanála", rssName:"Názov", rssFilt:"Filter (regex)", rssInt:"Interval (min)",
  rssAdded:"RSS kanál pridaný", rssRemoved:"RSS kanál odstránený",
  rssNoFeeds:"Žiadne RSS kanály", rssNoFeedsH:"Pridajte RSS kanál tlačidlom nižšie",
  ipList:"Zoznam blokovaných IP", ipListPh:"IP adresy alebo CIDR rozsahy, jeden na riadok\n192.168.1.0/24\n10.0.0.1",
  schedDays:"Po,Ut,St,Št,Pi,So,Ne",
  autoCleanup:"Auto-čistenie po uploade", autoCleanupS:"Po uploade na FTP zmazať lokálne súbory",
  storLocal:"Lokálne úložisko", storLocalDesc:"Predvolený adresár /downloads/complete",
  storCustom:"Vlastný adresár / Mount", storCustomDesc:"NFS, CIFS, SSHFS alebo SMB mount point", storCustomSub:"Bittora ukladá dáta priamo na zadanú cestu", storCustomPh:"/mnt/nas/downloads",
  storFtp:"FTP server", storFtpDesc:"Upload cez FTP pripojenie", storFtpInfo:"Dáta sa najprv stiahnu na lokálny disk, potom sa uploadnú na FTP server. Po uploade sa lokálne súbory automaticky zmažú (ak je povolené auto-čistenie).", storFtpNoConn:"Najprv pridajte FTP pripojenie v sekcii nižšie.",
  dlDirTest:"Overiť cestu", dlDirTesting:"Overujem...", dlDirOk:"Cesta je prístupná a zapisovateľná", dlDirFail:"Cesta neexistuje alebo nie je zapisovateľná", dlDirWarn:"Zmena cesty vyžaduje reštart služby",
  dCustom:"Vlastný adr.",
  mountHelper:"Mount zoznam", mountHelperDesc:"Vyberte pripojenie a skopírujte príkaz do terminálu", mountSelConn:"Vyberte pripojenie", mountCopy:"Skopírované!", mountStep1:"1. Spustite príkaz v termináli (jednorazovo)", mountStep2:"2. Pre trvalý mount pridajte riadok do /etc/fstab", mountStep3:"3. Cesta sa automaticky vyplní — kliknite Overiť", mountUseThis:"Použiť túto cestu",
  addNfs:"Pridať NFS", nfsNamePh:"Môj NFS server", nfsExport:"Export cesta", dNFS:"NFS",
  restartBtn:"Reštartovať", restarting:"Reštartujem...", restartOk:"Služba reštartovaná", restartFail:"Reštart zlyhal", restartConfirm:"Reštartovať službu Bittora?",
  mountBtn:"Pripojiť", unmountBtn:"Odpojiť", mounting:"Pripájam...", unmounting:"Odpájam...", mountOk:"Úložisko pripojené", mountFail:"Pripojenie zlyhalo", unmountOk:"Úložisko odpojené", unmountFail:"Odpojenie zlyhalo", mountConfirm:"Pripojiť úložisko?", unmountConfirm:"Odpojiť úložisko?",
  extStorSidebar:"Externé úložisko", noMounts:"Žiadne pripojené", fstabInfo:"Pre trvalý mount pridajte do /etc/fstab",
  netIfaceSec:"Rozhranie & IP", netIface:"Sieťové rozhranie", netIfaceS:"Rozhranie pre torrent spojenia", netIfaceAny:"Všetky rozhrania", netBindIp:"IP adresa pre naviazanie", netBindIpS:"Voliteľné — špecifická IP adresa", netBindIpPh:"napr. 192.168.1.100",
  sArr:"*arr integrácia", arrTitle:"Integrácia s *arr aplikáciami", arrEn:"qBittorrent API kompatibilita", arrEnS:"Sonarr, Radarr, Lidarr, Prowlarr pripojenie", arrInfo:"Nastavenia pripojenia pre *arr", arrProfile:"V *arr aplikácii vyberte: qBittorrent", arrHost:"Host", arrPort:"Port", arrUser:"Používateľ", arrPass:"Vaše heslo do Bittora", arrCat:"Kategória sa vytvorí automaticky",
};

const EN = {
  loginTitle:"Sign in to your account", loginUser:"Username", loginPass:"Password", loginBtn:"Sign in", loginLoading:"Signing in...", loginError:"Invalid credentials",
  loginInfo:"Default credentials:", loginInfoSub:"You will be asked to change your password on first login",
  changeTitle:"Set a new password for admin account", changeWarn:"Security notice", changeWarnText:"The default password is not secure. Please set a new one.",
  newPass:"New password", newPassPh:"Enter new password", confirmPass:"Confirm password", confirmPassPh:"Repeat new password",
  changeBtn:"Set password and continue", saving:"Saving...", passShort:"Password must be at least 4 characters", passNoMatch:"Passwords do not match",
  weak:"Weak", avg:"Fair", good:"Good", strong:"Strong", vstrong:"Very strong",
  search:"Search torrents...", add:"Add",
  fAll:"All", fDown:"Downloading", fDone:"Completed", fPause:"Paused", fQueue:"Queued", cats:"Categories",
  disk:"Disk space", free:"free", occ:"used",
  dl:"Download", ul:"Upload", active:"Active", done:"Completed",
  sel:"selected", pause:"Pause", resume:"Resume", remove:"Remove",
  name:"Name", status:"Status", progress:"Progress", speed:"Speed", sp:"S/P", dest:"Dest", eta:"ETA",
  noTor:"No torrents", noTorH:"Add torrents using the button above",
  stD:"Downloading", stC:"Done", stP:"Paused", stQ:"Queued", stE:"Error",
  dLocal:"Local", dFTP:"FTP", dSMB:"SMB",
  info:"Info", files:"Files", peers:"Peers", trackers:"Trackers",
  downloaded:"Downloaded", speedD:"Speed ↓", speedU:"Speed ↑", ratio:"Ratio", cat:"Category",
  settings:"Settings", save:"Save", cancel:"Cancel", saved:"Settings saved",
  sGen:"General", sNet:"Network", sDl:"Downloads", sStor:"Storage", sRss:"RSS feeds", sSched:"Scheduler", sWh:"Webhook", sUsers:"Users", sSec:"Security", sLog:"Logs", sAbout:"About",
  logTitle:"System logs", logEmpty:"No logs", logRefresh:"Refresh",
  webIface:"Web interface", appPort:"Application port", appPortS:"Port on which Bittora is accessible", availAt:"Available at",
  ui:"Interface", darkMode:"Dark mode", darkModeS:"Dark appearance", toast:"Toast notifications", toastS:"Push notifications", sound:"Sound alerts", soundS:"Sound on completion", lang:"Language",
  behavior:"Behavior", autoStart:"Auto-start torrents", autoStartS:"Start downloading immediately", confirmDel:"Confirm removal", confirmDelS:"Confirm before deleting",
  speedSec:"Speed", maxDL:"Max download", maxUL:"Max upload", maxGlob:"Max global connections", maxPer:"Max per torrent", unlim:"0 = unlimited",
  portProto:"Port & protocol", listenPort:"Listen port", upnp:"UPnP / NAT-PMP", upnpS:"Auto port forwarding", utp:"uTP", utpS:"Micro Transport Protocol",
  dhtSec:"DHT & Discovery", dht:"DHT", dhtS:"Distributed Hash Table", pex:"PEX", pexS:"Peer Exchange", lpd:"Local Peer Discovery", lpdS:"LAN peers",
  proxy:"Proxy", proxyType:"Proxy type", proxyNone:"None",
  limits:"Limits", maxActDL:"Max active downloads", maxActSeed:"Max active seeds", maxTot:"Max total",
  seeding:"Seeding", targetRatio:"Target ratio", maxSeedTime:"Max seed time", autoSeed:"Auto-seed after completion",
  prio:"Prioritization", seqDl:"Sequential download", seqDlS:"Download sequentially", flPiece:"First/Last piece", flPieceS:"Prioritize first and last piece",
  defStorage:"Default storage", defStorDesc:"Default storage for new torrents", extConn:"External connections", lastTest:"Last tested", online:"Online", offline:"Offline",
  ftpPathRequired:"Remote path is required for uploads", connUpdated:"Connection updated",
  rssFeeds:"RSS feeds", addRss:"Add RSS feed", autoDl:"Auto-download", autoDlM:"Auto-download matches", autoDlS:"Torrents matching filters", checkInt:"Check interval", matches:"matches",
  schedTitle:"Speed scheduler", schedEn:"Enable scheduler", schedEnS:"Limit speed by schedule", altLim:"Alt. limits", altDL:"Alt. download", altUL:"Alt. upload", full:"Full", limited:"Limited",
  whEn:"Enable webhook", whEnS:"HTTP notifications (Home Assistant, Node-RED...)", whEnd:"Endpoint", whAcc:"Access",
  whPub:"Public", whPubS:"No authentication", whPass:"With password", whPassS:"Requires API key",
  whKey:"API key", whGen:"Gen.", whKeyGen:"API key generated", whEvt:"Events",
  whAdded:"Torrent added", whProg:"Progress change", whComp:"Completed", whErr:"Error", whRem:"Removed",
  whPayload:"Payload example", whInteg:"Home Assistant / Node-RED / IFTTT", urlCop:"URL copied",
  userMgmt:"User management", fullPerm:"Full permissions", limPerm:"Limited permissions",
  pDl:"Download", pDlS:"Can download torrents", pUl:"Upload", pUlS:"Can add new torrents", pExt:"External storage", pExtS:"Can use FTP/SMB", pWh:"Webhook", pWhS:"Access to webhook settings",
  perms:"Permissions", addUsr:"Add user", newUsr:"New user", create:"Create",
  usrName:"Name", usrCreated:"created", usrRemoved:"User removed", usrExists:"User already exists", fillBoth:"Fill in name and password",
  secAcc:"Access", reqLogin:"Require login", reqLoginS:"Access only after auth",
  sessTimeout:"Session timeout", sessTimeoutS:"Auto-logout", encrypt:"Encryption", forceEnc:"Force encryption", forceEncS:"Require encrypted connections",
  anon:"Anonymous mode", anonS:"Do not send identification", ipFilt:"IP filters", enIpFilt:"Enable IP filters", enIpFiltS:"Block malicious IPs",
  torLim:"Torrent limits", globLimActive:"Global limits active", limSaved:"Limits saved",
  built:"FastAPI + libtorrent + React", wsRT:"WebSocket real-time",
  tPaused:"paused", tResumed:"resumed", tRemoved:"removed", tDone:"completed!", tAdded:"torrent(s) added",
  addTorrent:"Add torrent", addMagnet:"Magnet link", addFile:"Torrent file",
  magnetPh:"Paste magnet link(s), one per line", dropzone:"Drag .torrent files here",
  browse:"Browse", startNow:"Start immediately", addBtn:"Add", selCat:"Category",
  noCat:"No category", selDest:"Destination", filesSelected:"files",
  sCats:"Categories", catMgmt:"Category management", addCat:"Add", catName:"Name", catNamePh:"e.g. Movies, Music...", noCatYet:"No categories yet", catColor:"Color",
  extStorage:"External storage", addFtp:"Add FTP", addSmb:"Add SMB", noExtConn:"No external storage", noExtConnH:"Add an FTP or SMB storage using the buttons below", host:"Host", connPort:"Port", connUser:"Username", connPass:"Password", remotePath:"Remote path", share:"Share", connName:"Connection name", addConn:"Add", connAdded:"Storage added", connRemoved:"Storage removed", ftpNamePh:"My FTP server", smbNamePh:"My SMB server", actBadge:"ACTIVE", connTest:"Test", connOnline:"Connection successful", connOffline:"Connection failed", connTesting:"Testing...", noMagnets:"No valid magnet links", addError:"Error adding torrent",
  sAcc:"Account", accRoleAdmin:"Administrator", accRoleUser:"User", curPass:"Current password", curPassPh:"Enter current password", accSaved:"Password changed successfully", accChPass:"Change password",
  filters:"Filters", delTitle:"Remove torrent", delOptList:"Remove from list only", delOptListS:"Downloaded files stay on disk", delOptFiles:"Delete files too", delOptFilesS:"Permanently deletes downloaded/incomplete files", torrentsCnt:"torrents",
  addTrackers:"Trackers (optional)", trackersPh:"Tracker URL, one per line",
  portRestartNote:"Port change requires a restart of the Bittora service",
  noSslNote:"App is running over HTTP (no SSL). Webhook URL will also be HTTP.",
  whOutUrl:"Outgoing webhook URL", logout:"Log out",
  rssUrl:"Feed URL", rssName:"Name", rssFilt:"Filter (regex)", rssInt:"Interval (min)",
  rssAdded:"RSS feed added", rssRemoved:"RSS feed removed",
  rssNoFeeds:"No RSS feeds", rssNoFeedsH:"Add an RSS feed using the button below",
  ipList:"Blocked IP list", ipListPh:"IP addresses or CIDR ranges, one per line\n192.168.1.0/24\n10.0.0.1",
  schedDays:"Mo,Tu,We,Th,Fr,Sa,Su",
  autoCleanup:"Auto-cleanup after upload", autoCleanupS:"Delete local files after FTP upload",
  storLocal:"Local storage", storLocalDesc:"Default directory /downloads/complete",
  storCustom:"Custom directory / Mount", storCustomDesc:"NFS, CIFS, SSHFS or SMB mount point", storCustomSub:"Bittora saves data directly to the specified path", storCustomPh:"/mnt/nas/downloads",
  storFtp:"FTP server", storFtpDesc:"Upload via FTP connection", storFtpInfo:"Data is first downloaded to local disk, then uploaded to the FTP server. Local files are automatically deleted after upload (if auto-cleanup is enabled).", storFtpNoConn:"First add an FTP connection in the section below.",
  dlDirTest:"Test path", dlDirTesting:"Testing...", dlDirOk:"Path is accessible and writable", dlDirFail:"Path does not exist or is not writable", dlDirWarn:"Path change requires a service restart",
  dCustom:"Custom dir",
  mountHelper:"Mount list", mountHelperDesc:"Select a connection and copy the command to your terminal", mountSelConn:"Select connection", mountCopy:"Copied!", mountStep1:"1. Run the command in terminal (one-time)", mountStep2:"2. For persistent mount add the line to /etc/fstab", mountStep3:"3. Path is auto-filled — click Test to verify", mountUseThis:"Use this path",
  addNfs:"Add NFS", nfsNamePh:"My NFS server", nfsExport:"Export path", dNFS:"NFS",
  restartBtn:"Restart", restarting:"Restarting...", restartOk:"Service restarted", restartFail:"Restart failed", restartConfirm:"Restart Bittora service?",
  mountBtn:"Connect", unmountBtn:"Disconnect", mounting:"Connecting...", unmounting:"Disconnecting...", mountOk:"Storage connected", mountFail:"Connection failed", unmountOk:"Storage disconnected", unmountFail:"Disconnect failed", mountConfirm:"Connect storage?", unmountConfirm:"Disconnect storage?",
  extStorSidebar:"External storage", noMounts:"No mounts", fstabInfo:"For persistent mount add to /etc/fstab",
  netIfaceSec:"Interface & IP", netIface:"Network interface", netIfaceS:"Interface for torrent connections", netIfaceAny:"All interfaces", netBindIp:"Optional IP to bind to", netBindIpS:"Optional — specific IP address", netBindIpPh:"e.g. 192.168.1.100",
  sArr:"*arr Integration", arrTitle:"Integration with *arr Apps", arrEn:"qBittorrent API compatibility", arrEnS:"Sonarr, Radarr, Lidarr, Prowlarr connection", arrInfo:"Connection settings for *arr apps", arrProfile:"In your *arr app select: qBittorrent", arrHost:"Host", arrPort:"Port", arrUser:"Username", arrPass:"Your Bittora password", arrCat:"Category is created automatically",
};

const LANGS = {sk:SK,en:EN};
const LCtx = createContext({t:SK,lang:"sk",setLang:()=>{}});
const useT = () => useContext(LCtx);

/* ─── Reusable ─── */
const Tog = ({value,onChange,label,sub}) => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0"}}>
    <div><div style={{fontSize:14,color:C.text}}>{label}</div>{sub&&<div style={{fontSize:11,color:C.muted,marginTop:2}}>{sub}</div>}</div>
    <button onClick={()=>onChange(!value)} style={{width:40,height:22,borderRadius:11,background:value?C.vio:"rgba(255,255,255,0.1)",border:"none",position:"relative",cursor:"pointer",flexShrink:0}}><div style={{width:18,height:18,borderRadius:9,background:"#fff",position:"absolute",top:2,transition:"all .2s",...(value?{right:2}:{left:2})}}/></button>
  </div>
);
const NIn = ({label,value,onChange,unit,sub,step}) => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0"}}>
    <div><div style={{fontSize:14,color:C.text}}>{label}</div>{sub&&<div style={{fontSize:11,color:C.muted,marginTop:2}}>{sub}</div>}</div>
    <div style={{display:"flex",alignItems:"center",gap:8}}><input type="number" min="0" step={step||"1"} value={value} onChange={e=>onChange&&onChange(e.target.value)} style={{...sInp,width:96,textAlign:"right",padding:"6px 12px"}}/>{unit&&<span style={{fontSize:11,color:C.muted,width:32}}>{unit}</span>}</div>
  </div>
);
const Sec = ({title,icon,children}) => (
  <div style={{marginBottom:24}}><div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1.5,display:"flex",alignItems:"center",gap:8,marginBottom:12,paddingBottom:8,borderBottom:`1px solid ${C.border}`}}><I n={icon} style={{color:C.vioL}}/>{title}</div>{children}</div>
);
const PBar = ({progress,status}) => {
  const clr = {completed:C.em,downloading:C.vio,paused:C.amb,queued:"#6b7280",error:C.red}[status]||"#6b7280";
  return <div style={{width:"100%",background:"rgba(255,255,255,0.06)",borderRadius:4,height:6,overflow:"hidden"}}><div style={{width:`${progress}%`,height:"100%",borderRadius:4,background:clr,transition:"width .7s"}}/></div>;
};
const SBadge = ({status}) => {
  const {t}=useT();
  const m={downloading:{c:"#818cf8",bg:"rgba(99,102,241,0.1)",b:"rgba(99,102,241,0.2)",ic:"fa-arrow-down",l:t.stD},completed:{c:"#34d399",bg:"rgba(16,185,129,0.1)",b:"rgba(16,185,129,0.2)",ic:"fa-circle-check",l:t.stC},paused:{c:"#fbbf24",bg:"rgba(245,158,11,0.1)",b:"rgba(245,158,11,0.2)",ic:"fa-pause",l:t.stP},queued:{c:"#9ca3af",bg:"rgba(156,163,175,0.1)",b:"rgba(156,163,175,0.2)",ic:"fa-clock",l:t.stQ}};
  const x=m[status]||m.queued;
  return <span style={{fontSize:11,padding:"4px 10px",borderRadius:8,border:`1px solid ${x.b}`,background:x.bg,color:x.c,display:"inline-flex",alignItems:"center",gap:6}}><I n={`fa-solid ${x.ic}`}/>{x.l}</span>;
};
const DBadge = ({d}) => {
  const {t}=useT();
  const m={local:{ic:"fa-hard-drive",l:t.dLocal,c:C.dim},ftp:{ic:"fa-globe",l:t.dFTP,c:"#c084fc"},smb:{ic:"fa-network-wired",l:t.dSMB,c:"#22d3ee"},custom:{ic:"fa-folder-open",l:t.dCustom,c:"#3b82f6"},nfs:{ic:"fa-folder-tree",l:t.dNFS,c:"#f59e0b"}};
  const x=m[d]||m.local;
  return <span style={{fontSize:11,color:x.c,display:"flex",alignItems:"center",gap:6}}><I n={`fa-solid ${x.ic}`}/>{x.l}</span>;
};
const SCrd = ({label,value,icon,color}) => (
  <div style={{...glass,padding:16,display:"flex",alignItems:"center",gap:12}}>
    <div style={{width:44,height:44,borderRadius:12,background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}><I n={icon}/></div>
    <div><div style={{fontSize:20,fontWeight:700,color:"#fff"}}>{value}</div><div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1}}>{label}</div></div>
  </div>
);
const Toast = ({message,type,onClose,mob}) => {
  const[fading,setFading]=useState(false);
  useEffect(()=>{const t1=setTimeout(()=>setFading(true),2500);const t2=setTimeout(onClose,3000);return()=>{clearTimeout(t1);clearTimeout(t2);};},[]);// eslint-disable-line react-hooks/exhaustive-deps
  const bg={success:`linear-gradient(135deg,rgba(16,185,129,0.9),rgba(5,150,105,0.9))`,error:`linear-gradient(135deg,rgba(239,68,68,0.9),rgba(220,38,38,0.9))`,info:`linear-gradient(135deg,rgba(124,58,237,0.9),rgba(79,70,229,0.9))`,warning:`linear-gradient(135deg,rgba(245,158,11,0.9),rgba(217,119,6,0.9))`}[type]||"rgba(124,58,237,0.9)";
  const ic={success:"fa-circle-check",error:"fa-circle-xmark",info:"fa-circle-info",warning:"fa-triangle-exclamation"}[type]||"fa-circle-info";
  const anim=fading?(mob?"toastFadeOut 0.35s ease-out forwards":"bSlideOut 0.5s ease-out forwards"):(mob?"toastDropIn 0.3s cubic-bezier(.2,.8,.3,1)":"bSlideIn .35s cubic-bezier(.2,.8,.3,1)");
  return <div style={{background:bg,color:"#fff",padding:"12px 16px",borderRadius:12,display:"flex",alignItems:"center",gap:12,...(mob?{}:{minWidth:320}),border:"1px solid rgba(255,255,255,0.1)",backdropFilter:"blur(8px)",animation:anim}}><I n={`fa-solid ${ic}`}/><span style={{fontSize:14,fontWeight:500,flex:1}}>{message}</span><button onClick={onClose} style={{background:"none",border:"none",color:"rgba(255,255,255,0.6)",cursor:"pointer"}}><I n="fa-solid fa-xmark"/></button></div>;
};

/* ═══════════════ TOR LIMIT PANEL ═══════════════ */
const TorLimitPanel=({detail,addToast,globalDl,globalUl})=>{
  const{t}=useT();
  const[dl,setDl]=useState(String(detail.torLimDl||0));
  const[ul,setUl]=useState(String(detail.torLimUl||0));
  const[saving,setSaving]=useState(false);
  useEffect(()=>{setDl(String(detail.torLimDl||0));setUl(String(detail.torLimUl||0));},[detail.info_hash]);
  const save=async()=>{setSaving(true);try{await apiFetch(`/api/torrents/${detail.info_hash}/limits`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({download_limit:parseInt(dl)||0,upload_limit:parseInt(ul)||0})});addToast(t.limSaved,"success");}catch(e){addToast(e.message,"error");}finally{setSaving(false);};};
  const hasGlob=(parseInt(globalDl)||0)>0||(parseInt(globalUl)||0)>0;
  return<div style={{background:"rgba(255,255,255,0.03)",borderRadius:14,padding:"12px 14px",border:`1px solid rgba(255,255,255,0.05)`}}>
    <div style={{fontSize:11,color:C.muted,marginBottom:10,display:"flex",alignItems:"center",gap:6}}><I n="fa-solid fa-gauge" style={{color:C.vioL}}/>{t.torLim}</div>
    {hasGlob&&<div style={{background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.25)",borderRadius:8,padding:"6px 10px",fontSize:10,color:"#fde68a",marginBottom:8,display:"flex",alignItems:"center",gap:6}}><I n="fa-solid fa-triangle-exclamation" style={{color:C.amb}}/>{t.globLimActive}: ↓{globalDl} ↑{globalUl} KB/s</div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
      <div><label style={{fontSize:10,color:C.muted,display:"block",marginBottom:4}}><I n="fa-solid fa-arrow-down" style={{color:C.em,marginRight:3}}/>{t.maxDL} KB/s</label><input type="number" min="0" value={dl} onChange={e=>setDl(e.target.value)} style={{...sInp,padding:"6px 10px",fontSize:12,textAlign:"right"}}/></div>
      <div><label style={{fontSize:10,color:C.muted,display:"block",marginBottom:4}}><I n="fa-solid fa-arrow-up" style={{color:C.vioL,marginRight:3}}/>{t.maxUL} KB/s</label><input type="number" min="0" value={ul} onChange={e=>setUl(e.target.value)} style={{...sInp,padding:"6px 10px",fontSize:12,textAlign:"right"}}/></div>
    </div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span style={{fontSize:10,color:"#4b5563"}}>{t.unlim}</span>
      <button onClick={save} disabled={saving} style={{...sBtn,padding:"6px 14px",fontSize:11,opacity:saving?.6:1}}>{saving?<I n="fa-solid fa-spinner fa-spin"/>:<><I n="fa-solid fa-floppy-disk" style={{marginRight:4}}/>{t.save}</>}</button>
    </div>
  </div>;
};

/* ═══════════════ LOGIN ═══════════════ */
const Login = ({onLogin,lang,setLang}) => {
  const t=LANGS[lang];
  const [step,setStep]=useState("login");
  const [u,setU]=useState("");const [p,setP]=useState("");
  const [np,setNp]=useState("");const [cp,setCp]=useState("");
  const [err,setErr]=useState("");const [ld,setLd]=useState(false);
  const [showP,setShowP]=useState(false);const [showN,setShowN]=useState(false);
  const [showDefCreds,setShowDefCreds]=useState(false);
  useEffect(()=>{fetch("/api/auth/status").then(r=>r.json()).then(d=>{if(d.show_default_creds)setShowDefCreds(true);}).catch(()=>{});},[]);

  const [loginData,setLoginData]=useState(null);
  const doLogin=async e=>{if(e)e.preventDefault();if(ld)return;setLd(true);setErr("");
    try{const d=await apiFetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})});
      if(d.must_change_pw){setLoginData(d);setStep("change");}else{onLogin(d);}
    }catch(ex){setErr(t.loginError);}finally{setLd(false);} };
  const doChange=async e=>{if(e)e.preventDefault();if(ld)return;if(np.length<4){setErr(t.passShort);return;}if(np!==cp){setErr(t.passNoMatch);return;}setLd(true);setErr("");
    try{await apiFetch("/api/auth/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({current_password:p,new_password:np})});
      const me=await apiFetch("/api/auth/me");onLogin(me);
    }catch(ex){setErr(ex.message||t.passNoMatch);}finally{setLd(false);} };
  const ps=v=>{if(!v)return{w:0,l:"",c:""};let s=0;if(v.length>=4)s++;if(v.length>=8)s++;if(/[A-Z]/.test(v)&&/[a-z]/.test(v))s++;if(/\d/.test(v))s++;if(/[^a-zA-Z0-9]/.test(v))s++;if(s<=1)return{w:20,l:t.weak,c:C.red};if(s<=2)return{w:40,l:t.avg,c:C.amb};if(s<=3)return{w:60,l:t.good,c:"#eab308"};if(s<=4)return{w:80,l:t.strong,c:C.em};return{w:100,l:t.vstrong,c:"#34d399"};};
  const str=ps(np);

  return (
    <div style={{minHeight:"100dvh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:16,backgroundImage:"radial-gradient(ellipse at 30% 0%,rgba(139,92,246,.12) 0%,transparent 50%),radial-gradient(ellipse at 70% 100%,rgba(99,102,241,.08) 0%,transparent 50%)",overflow:"hidden"}}>
      <div style={{position:"fixed",top:16,right:16,display:"flex",gap:4,zIndex:10}}>
        {["sk","en"].map(l=><button key={l} onClick={()=>setLang(l)} style={{padding:"6px 12px",borderRadius:8,fontSize:11,fontWeight:600,cursor:"pointer",textTransform:"uppercase",border:lang===l?"1px solid rgba(139,92,246,0.4)":`1px solid ${C.border}`,background:lang===l?"rgba(139,92,246,0.15)":"rgba(255,255,255,0.03)",color:lang===l?"#a78bfa":C.muted}}>{l}</button>)}
      </div>
      <div style={{...glass,padding:"24px 24px 28px",width:"100%",maxWidth:420,borderRadius:24}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:80,height:80,margin:"0 auto 16px",borderRadius:20,background:`linear-gradient(135deg,${C.vio},${C.ind})`,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 32px rgba(124,58,237,0.3)"}}><I n="fa-solid fa-hurricane" style={{fontSize:32,color:"#fff"}}/></div>
          <h1 style={{fontSize:28,fontWeight:800,background:"linear-gradient(135deg,#c4b5fd,#93c5fd)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",margin:0}}>Bittora</h1>
          <p style={{fontSize:14,color:C.muted,marginTop:8}}>{step==="login"?t.loginTitle:t.changeTitle}</p>
        </div>

        {step==="login"?(
          <form onSubmit={doLogin} style={{display:"flex",flexDirection:"column",gap:16}}>
            <div><label style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:8}}><I n="fa-solid fa-user"/> {t.loginUser}</label><div style={{position:"relative"}}><I n="fa-solid fa-user" style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:C.muted,fontSize:13}}/><input type="text" autoComplete="username" value={u} onChange={e=>setU(e.target.value)} placeholder="admin" style={sInpI}/></div></div>
            <div><label style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:8}}><I n="fa-solid fa-lock"/> {t.loginPass}</label><div style={{position:"relative"}}><I n="fa-solid fa-lock" style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:C.muted,fontSize:13}}/><input type={showP?"text":"password"} autoComplete="current-password" value={p} onChange={e=>setP(e.target.value)} placeholder="••••••" style={sInpI}/><button type="button" onClick={()=>setShowP(!showP)} style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer"}}><I n={showP?"fa-solid fa-eye-slash":"fa-solid fa-eye"}/></button></div></div>
            {err&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:12,padding:"10px 16px",display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-circle-exclamation" style={{color:C.red}}/><span style={{fontSize:13,color:"#fca5a5"}}>{err}</span></div>}
            <button type="submit" disabled={ld} style={{...sBtn,opacity:ld?.5:1}}>{ld?<><I n="fa-solid fa-spinner fa-spin"/> {t.loginLoading}</>:<><I n="fa-solid fa-right-to-bracket"/> {t.loginBtn}</>}</button>
            {showDefCreds&&<div style={{background:"rgba(139,92,246,0.1)",border:"1px solid rgba(139,92,246,0.2)",borderRadius:12,padding:"12px 16px",display:"flex",alignItems:"flex-start",gap:8}}>
              <I n="fa-solid fa-circle-info" style={{color:"#a78bfa",marginTop:2}}/>
              <div><p style={{fontSize:12,color:"#c4b5fd",margin:0}}>{t.loginInfo} <code style={{background:"rgba(255,255,255,0.06)",padding:"2px 6px",borderRadius:4,color:"#a78bfa"}}>admin</code> / <code style={{background:"rgba(255,255,255,0.06)",padding:"2px 6px",borderRadius:4,color:"#a78bfa"}}>admin</code></p><p style={{fontSize:10,color:"rgba(167,139,250,0.6)",marginTop:4}}><I n="fa-solid fa-shield-halved"/> {t.loginInfoSub}</p></div>
            </div>}
          </form>
        ):(
          <form onSubmit={doChange} style={{display:"flex",flexDirection:"column",gap:16}}>
            <div style={{background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:12,padding:"12px 16px",display:"flex",alignItems:"flex-start",gap:8}}><I n="fa-solid fa-triangle-exclamation" style={{color:C.amb,marginTop:2}}/><div><p style={{fontSize:12,color:"#fde68a",margin:0}}>{t.changeWarn}</p><p style={{fontSize:10,color:"rgba(253,230,138,0.6)",marginTop:4}}>{t.changeWarnText}</p></div></div>
            <div><label style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:8}}><I n="fa-solid fa-key"/> {t.newPass}</label><div style={{position:"relative"}}><I n="fa-solid fa-key" style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:C.muted,fontSize:13}}/><input type={showN?"text":"password"} value={np} onChange={e=>setNp(e.target.value)} placeholder={t.newPassPh} style={sInpI}/><button type="button" onClick={()=>setShowN(!showN)} style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer"}}><I n={showN?"fa-solid fa-eye-slash":"fa-solid fa-eye"}/></button></div>
            {np&&<div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}><div style={{flex:1,background:"rgba(255,255,255,0.06)",borderRadius:4,height:6,overflow:"hidden"}}><div style={{width:`${str.w}%`,height:"100%",borderRadius:4,background:str.c,transition:"all .5s"}}/></div><span style={{fontSize:10,color:C.muted,width:80,textAlign:"right"}}>{str.l}</span></div>}</div>
            <div><label style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:8}}><I n="fa-solid fa-check-double"/> {t.confirmPass}</label><div style={{position:"relative"}}><I n="fa-solid fa-check-double" style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:C.muted,fontSize:13}}/><input type="password" value={cp} onChange={e=>setCp(e.target.value)} placeholder={t.confirmPassPh} style={sInpI}/>{cp&&<span style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",color:np===cp?C.em:C.red}}><I n={np===cp?"fa-solid fa-circle-check":"fa-solid fa-circle-xmark"}/></span>}</div></div>
            {err&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:12,padding:"10px 16px",display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-circle-exclamation" style={{color:C.red}}/><span style={{fontSize:13,color:"#fca5a5"}}>{err}</span></div>}
            <button type="submit" disabled={ld||!np||!cp} style={{...sBtn,opacity:(ld||!np||!cp)?.5:1}}>{ld?<><I n="fa-solid fa-spinner fa-spin"/> {t.saving}</>:<><I n="fa-solid fa-shield-halved"/> {t.changeBtn}</>}</button>
          </form>
        )}
      </div>
    </div>
  );
};

/* ═══════════════ SETTINGS ═══════════════ */
const Settings = ({onClose,addToast,users,setUsers,currentUser,onLogout,lang,setLang,categories,setCategories,connections,setConnections,openToTab="general",onSettingsChange,refreshDisk}) => {
  const {t}=useT();
  const [tab,setTab]=useState(openToTab);
  const [mobShowList,setMobShowList]=useState(openToTab==="general");
  const [sd,setSd]=useState({});const [saving,setSaving]=useState(false);
  const [accCurPass,setAccCurPass]=useState("");const [accNewPass,setAccNewPass]=useState("");const [accConfPass,setAccConfPass]=useState("");const [accErr,setAccErr]=useState("");const [accOk,setAccOk]=useState(false);
  const [newCatName,setNewCatName]=useState("");const [newCatColor,setNewCatColor]=useState("#8b5cf6");
  const [showAddConn,setShowAddConn]=useState(false);const [connType,setConnType]=useState("ftp");const [connForm,setConnForm]=useState({name:"",host:"",port:"",user:"",pass:"",path:""});const [testingConnId,setTestingConnId]=useState(null);const [testingNewConn,setTestingNewConn]=useState(false);const [newConnResult,setNewConnResult]=useState(null);const [editingConnId,setEditingConnId]=useState(null);
  useEffect(()=>{if(!newConnResult)return;const t=setTimeout(()=>setNewConnResult(null),5000);return()=>clearTimeout(t);},[newConnResult]);
  const [testingPath,setTestingPath]=useState(false);const [pathResult,setPathResult]=useState(null);const [smbMountConn,setSmbMountConn]=useState("");const [restarting,setRestarting]=useState(false);const [mounting,setMounting]=useState(false);const [unmountConfirm,setUnmountConfirm]=useState(false);
  const [restartArm,setRestartArm]=useState(false);
  const [netIfaces,setNetIfaces]=useState([]);
  useEffect(()=>{if(tab==="network")apiFetch("/api/network/interfaces").then(setNetIfaces).catch(()=>{});},[tab]);
  const doRestart=async()=>{if(!restartArm){setRestartArm(true);setTimeout(()=>setRestartArm(false),3000);return;}setRestartArm(false);setRestarting(true);try{await apiFetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:sd})});await apiFetch("/api/settings/restart",{method:"POST"});addToast(t.restartOk,"success");const newPort=sd.web_port||"8080";const target=window.location.protocol+"//"+window.location.hostname+":"+newPort;const poll=async(n)=>{if(n<=0){window.location.href=target;return;}try{await fetch(target+"/api/auth/me",{credentials:"include",signal:AbortSignal.timeout(2000)});window.location.href=target;}catch{setTimeout(()=>poll(n-1),1500);}};setTimeout(()=>poll(10),2000);}catch(e){addToast(t.restartFail+": "+e.message,"error");setRestarting(false);}};
  useEffect(()=>{if(!pathResult)return;const tm=setTimeout(()=>setPathResult(null),5000);return()=>clearTimeout(tm);},[pathResult]);
  const [rssFeeds,setRssFeeds]=useState([]);const [showAddRss,setShowAddRss]=useState(false);const [rssForm,setRssForm]=useState({url:"",name:"",filter:"",interval:30,auto_dl:false});
  const [logs,setLogs]=useState([]);const [logsLoading,setLogsLoading]=useState(false);
  const loadLogs=async()=>{setLogsLoading(true);try{const r=await apiFetch("/api/logs");setLogs(r||[]);}catch(e){}finally{setLogsLoading(false);}};
  useEffect(()=>{if(tab==="log")loadLogs();},[tab]);
  const isA=currentUser?.role==="admin";
  const isMob=typeof window!=="undefined"&&window.innerWidth<=640;
  const tabs=[{k:"general",ic:"fa-gear",l:t.sGen},{k:"network",ic:"fa-network-wired",l:t.sNet},{k:"downloads",ic:"fa-download",l:t.sDl},{k:"storage",ic:"fa-database",l:t.sStor},{k:"categories",ic:"fa-tags",l:t.sCats},{k:"rss",ic:"fa-rss",l:t.sRss},{k:"scheduler",ic:"fa-calendar-days",l:t.sSched},{k:"webhook",ic:"fa-tower-broadcast",l:t.sWh},{k:"arr",ic:"fa-wand-magic-sparkles",l:t.sArr},...(isA?[{k:"users",ic:"fa-users-gear",l:t.sUsers}]:[]),{k:"security",ic:"fa-shield-halved",l:t.sSec},{k:"account",ic:"fa-circle-user",l:t.sAcc},...(isA?[{k:"log",ic:"fa-terminal",l:t.sLog}]:[]),{k:"about",ic:"fa-circle-info",l:t.sAbout}];

  const sv=(k,v)=>setSd(p=>({...p,[k]:String(v)}));
  const svSilent=(k,v)=>{const val=String(v);setSd(p=>({...p,[k]:val}));apiFetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:{[k]:val}})}).then(()=>{if(onSettingsChange)setSd(p=>{onSettingsChange(p);return p;});}).catch(()=>{});};
  const sb=(k,def)=>sd[k]!==undefined?sd[k]==="true":def;
  const sn=(k,def)=>sd[k]!==undefined?sd[k]:String(def);
  const whEvtObj=(()=>{try{return JSON.parse(sd.webhook_events||"{}");}catch{return{added:true,progress:false,completed:true,error:true,removed:false};}})();
  const setWhEvt=(k,v)=>sv("webhook_events",JSON.stringify({...whEvtObj,[k]:v}));
  const serverUrl=typeof window!=="undefined"?window.location.protocol+"//"+window.location.host:"";
  const webhookUrl=serverUrl+"/api/webhook";
  const isHttp=typeof window!=="undefined"&&window.location.protocol==="http:";

  useEffect(()=>{
    apiFetch("/api/settings").then(d=>setSd(d||{})).catch(()=>{});
    apiFetch("/api/rss").then(setRssFeeds).catch(()=>{});
  },[]);

  const doSave=async()=>{
    if(saving)return;setSaving(true);
    try{await apiFetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:sd})});
      if(onSettingsChange)onSettingsChange(sd);addToast(t.saved,"success");
    }catch(e){addToast(e.message||"Error","error");}finally{setSaving(false);}
  };

  const TabContent = ()=><>
    {tab==="general"&&<><Sec title={t.webIface} icon="fa-solid fa-globe"><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0"}}><div><div style={{fontSize:14,color:C.text}}>{t.appPort}</div><div style={{fontSize:11,color:C.muted,marginTop:2}}>{t.appPortS}</div></div><input value={sn("web_port","8080")} onChange={e=>sv("web_port",e.target.value)} style={{...sInp,width:96,textAlign:"right",padding:"6px 12px",fontFamily:"monospace"}}/></div><div style={{background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:10,padding:"8px 12px",marginTop:4,display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-triangle-exclamation" style={{color:C.amb,fontSize:11}}/><span style={{fontSize:10,color:"#fde68a",flex:1}}>{t.portRestartNote}</span><button disabled={restarting} onClick={doRestart} style={{...sGhost,padding:"4px 10px",border:`1px solid ${restartArm?"rgba(239,68,68,0.6)":"rgba(245,158,11,0.3)"}`,borderRadius:8,fontSize:10,color:restartArm?"#fff":"#fde68a",background:restartArm?"rgba(239,68,68,0.7)":"transparent",display:"flex",alignItems:"center",gap:5,flexShrink:0,opacity:restarting?.5:1,transition:"all .2s"}}>{restarting?<I n="fa-solid fa-spinner fa-spin"/>:restartArm?<I n="fa-solid fa-triangle-exclamation"/>:<I n="fa-solid fa-rotate"/>}{restarting?t.restarting:restartArm?t.restartConfirm:t.restartBtn}</button></div><div style={{background:"rgba(139,92,246,0.1)",border:"1px solid rgba(139,92,246,0.2)",borderRadius:12,padding:"8px 12px",marginTop:6,display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-circle-info" style={{color:C.vioL,fontSize:11}}/><span style={{fontSize:10,color:"#c4b5fd"}}>{t.availAt} <code style={{background:"rgba(255,255,255,0.06)",padding:"2px 6px",borderRadius:4}}>{serverUrl}</code></span></div>{isHttp&&<div style={{background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:10,padding:"8px 12px",marginTop:4,display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-triangle-exclamation" style={{color:C.amb,fontSize:11}}/><span style={{fontSize:10,color:"#fde68a"}}>{t.noSslNote}</span></div>}</Sec><Sec title={t.ui} icon="fa-solid fa-palette"><Tog value={sb("toast_notif",true)} onChange={v=>sv("toast_notif",v)} label={t.toast} sub={t.toastS}/><Tog value={sb("sound_notif",false)} onChange={v=>sv("sound_notif",v)} label={t.sound} sub={t.soundS}/><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0"}}><div style={{fontSize:14,color:C.text}}>{t.lang}</div><select value={lang} onChange={e=>setLang(e.target.value)} style={{...sInp,width:"auto",padding:"6px 12px",cursor:"pointer"}}><option value="sk" style={{background:"#1a1d2e"}}>Slovenčina</option><option value="en" style={{background:"#1a1d2e"}}>English</option></select></div></Sec><Sec title={t.behavior} icon="fa-solid fa-sliders"><Tog value={sb("auto_start",true)} onChange={v=>sv("auto_start",v)} label={t.autoStart} sub={t.autoStartS}/><Tog value={sb("confirm_del",true)} onChange={v=>sv("confirm_del",v)} label={t.confirmDel} sub={t.confirmDelS}/></Sec></>}
    {tab==="network"&&<><Sec title={t.speedSec} icon="fa-solid fa-gauge-high"><NIn label={t.maxDL} value={sn("max_dl_speed","0")} onChange={v=>sv("max_dl_speed",v)} unit="KB/s" sub={t.unlim}/><NIn label={t.maxUL} value={sn("max_ul_speed","0")} onChange={v=>sv("max_ul_speed",v)} unit="KB/s" sub={t.unlim}/><NIn label={t.maxGlob} value={sn("max_global_conn","500")} onChange={v=>sv("max_global_conn",v)}/><NIn label={t.maxPer} value={sn("max_per_torrent","100")} onChange={v=>sv("max_per_torrent",v)}/></Sec><Sec title={t.portProto} icon="fa-solid fa-plug"><NIn label={t.listenPort} value={sn("listen_port","6881")} onChange={v=>sv("listen_port",v)}/><Tog value={sb("upnp",true)} onChange={v=>sv("upnp",v)} label={t.upnp} sub={t.upnpS}/><Tog value={sb("utp",true)} onChange={v=>sv("utp",v)} label={t.utp} sub={t.utpS}/></Sec><Sec title={t.netIfaceSec} icon="fa-solid fa-ethernet"><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0"}}><div><div style={{fontSize:14,color:C.text}}>{t.netIface}</div><div style={{fontSize:11,color:C.muted,marginTop:2}}>{t.netIfaceS}</div></div><select value={sn("net_interface","")} onChange={e=>sv("net_interface",e.target.value)} style={{...sInp,width:260,cursor:"pointer"}}><option value="" style={{background:"#1a1d2e"}}>{t.netIfaceAny}</option>{netIfaces.filter(i=>i.name!=="lo").map(i=><option key={i.name} value={i.name} style={{background:"#1a1d2e"}}>{i.name}{i.ipv4.length?` (${i.ipv4[0]})`:""}</option>)}</select></div><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0"}}><div><div style={{fontSize:14,color:C.text}}>{t.netBindIp}</div><div style={{fontSize:11,color:C.muted,marginTop:2}}>{t.netBindIpS}</div></div><input value={sn("net_bind_ip","")} onChange={e=>sv("net_bind_ip",e.target.value)} placeholder={t.netBindIpPh} style={{...sInp,width:180,fontFamily:"monospace",fontSize:12}}/></div></Sec><Sec title={t.dhtSec} icon="fa-solid fa-compass"><Tog value={sb("dht",true)} onChange={v=>sv("dht",v)} label={t.dht} sub={t.dhtS}/><Tog value={sb("pex",true)} onChange={v=>sv("pex",v)} label={t.pex} sub={t.pexS}/><Tog value={sb("lpd",true)} onChange={v=>sv("lpd",v)} label={t.lpd} sub={t.lpdS}/></Sec></>}
    {tab==="downloads"&&<><Sec title={t.limits} icon="fa-solid fa-list-ol"><NIn label={t.maxActDL} value={sn("max_active_dl","5")} onChange={v=>sv("max_active_dl",v)}/><NIn label={t.maxActSeed} value={sn("max_active_seed","5")} onChange={v=>sv("max_active_seed",v)}/><NIn label={t.maxTot} value={sn("max_total","10")} onChange={v=>sv("max_total",v)}/></Sec><Sec title={t.seeding} icon="fa-solid fa-arrow-up-from-bracket"><NIn label={t.targetRatio} value={sn("target_ratio","2.0")} onChange={v=>sv("target_ratio",v)} unit="×" step="0.1"/><NIn label={t.maxSeedTime} value={sn("max_seed_time","0")} onChange={v=>sv("max_seed_time",v)} unit="min" sub={t.unlim}/><Tog value={sb("auto_seed",true)} onChange={v=>sv("auto_seed",v)} label={t.autoSeed}/></Sec><Sec title={t.prio} icon="fa-solid fa-arrow-up-1-9"><Tog value={sb("seq_dl",false)} onChange={v=>sv("seq_dl",v)} label={t.seqDl} sub={t.seqDlS}/><Tog value={sb("first_last_piece",true)} onChange={v=>sv("first_last_piece",v)} label={t.flPiece} sub={t.flPieceS}/></Sec></>}
    {tab==="storage"&&<><Sec title={t.defStorage} icon="fa-solid fa-hard-drive"><div style={{fontSize:11,color:C.muted,marginBottom:10}}>{t.defStorDesc}</div>{(()=>{const ds=sn("default_storage","local");const ftpConns=connections.filter(c=>c.type==="ftp");const hasFtpC=ftpConns.length>0;const storOpts=[{val:"local",icon:"fa-solid fa-hard-drive",clr:C.vioL,label:t.storLocal,desc:t.storLocalDesc},{val:"custom",icon:"fa-solid fa-folder-open",clr:"#3b82f6",label:t.storCustom,desc:t.storCustomDesc},...(hasFtpC?[{val:`conn:${ftpConns[0].id}`,icon:"fa-solid fa-globe",clr:"#c084fc",label:t.storFtp,desc:t.storFtpDesc}]:[])];return<>{storOpts.map(opt=>{const isAct=opt.val==="custom"?ds==="custom":(opt.val==="local"?ds==="local":ds.startsWith("conn:"));return<div key={opt.val}><div onClick={()=>svSilent("default_storage",opt.val)} style={{background:isAct?"rgba(139,92,246,0.08)":"rgba(255,255,255,0.03)",borderRadius:12,padding:12,marginBottom:isAct?0:8,cursor:"pointer",border:isAct?"1px solid rgba(139,92,246,0.3)":"1px solid transparent",transition:"all .15s"}}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:16,height:16,borderRadius:"50%",border:`2px solid ${isAct?C.vioL:C.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{isAct&&<div style={{width:8,height:8,borderRadius:"50%",background:C.vioL}}/>}</div><I n={opt.icon} style={{color:opt.clr,fontSize:14}}/><div style={{flex:1,minWidth:0}}><span style={{fontSize:13,color:"#fff",fontWeight:500}}>{opt.label}</span><div style={{fontSize:10,color:C.muted,marginTop:2}}>{opt.desc}</div></div>{isAct&&<span style={{fontSize:9,background:"rgba(16,185,129,0.1)",color:C.em,padding:"2px 8px",borderRadius:8,flexShrink:0}}>{t.actBadge}</span>}</div></div>{isAct&&opt.val==="custom"&&(()=>{const mountConns=connections.filter(c=>c.type==="smb"||c.type==="nfs");const selConn=mountConns.find(c=>String(c.id)===smbMountConn);const slug=(name)=>name.replace(/[^a-zA-Z0-9]/g,'-').toLowerCase();const mountPath=selConn?`/mnt/bittora/${slug(selConn.name)}`:"";const mountCmd=selConn?(selConn.type==="smb"?`sudo mkdir -p ${mountPath} && sudo mount -t cifs //${selConn.host}/${selConn.path||"share"} ${mountPath} -o username=${selConn.user||"guest"},password=***,uid=$(id -u bittora),gid=$(id -g bittora),file_mode=0775,dir_mode=0775`:`sudo mkdir -p ${mountPath} && sudo mount -t nfs ${selConn.host}:${selConn.path||"/export"} ${mountPath}`):"";const fstabLine=selConn?(selConn.type==="smb"?`//${selConn.host}/${selConn.path||"share"}  ${mountPath}  cifs  username=${selConn.user||"guest"},password=***,uid=bittora,gid=bittora,file_mode=0775,dir_mode=0775,_netdev  0 0`:`${selConn.host}:${selConn.path||"/export"}  ${mountPath}  nfs  defaults,_netdev  0 0`):"";const helperClr=selConn?.type==="nfs"?"#f59e0b":"#22d3ee";const helperBg=selConn?.type==="nfs"?"rgba(245,158,11,0.06)":"rgba(34,211,238,0.06)";const helperBdr=selConn?.type==="nfs"?"rgba(245,158,11,0.15)":"rgba(34,211,238,0.15)";return<div style={{background:"rgba(59,130,246,0.06)",borderRadius:"0 0 12px 12px",padding:"12px 12px 14px",marginBottom:8,border:"1px solid rgba(59,130,246,0.15)",borderTop:"none"}}><div style={{fontSize:11,color:"#93c5fd",marginBottom:8}}><I n="fa-solid fa-circle-info" style={{marginRight:6}}/>{t.storCustomSub}</div>{mountConns.length>0&&<div style={{background:helperBg,border:`1px solid ${helperBdr}`,borderRadius:10,padding:12,marginBottom:12}}><div style={{fontSize:11,color:helperClr,fontWeight:600,display:"flex",alignItems:"center",gap:6,marginBottom:8}}><I n={selConn?.type==="nfs"?"fa-solid fa-folder-tree":"fa-solid fa-network-wired"}/>{t.mountHelper}</div><select value={smbMountConn} onChange={e=>{setSmbMountConn(e.target.value);}} style={{...sInp,cursor:"pointer",marginBottom:10}}><option value="" style={{background:"#1a1d2e"}}>{t.mountSelConn}...</option>{mountConns.map(cn=><option key={cn.id} value={String(cn.id)} style={{background:"#1a1d2e"}}>{cn.name} — {cn.type==="nfs"?`${cn.host}:${cn.path||"/"}`:`//${cn.host}/${cn.path||""}`} ({cn.type.toUpperCase()})</option>)}</select>{selConn&&<>{(()=>{const isMounted=sn("download_dir","")===mountPath;return<div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{!isMounted&&<button disabled={mounting} onClick={async()=>{setMounting(true);try{const r=await apiFetch("/api/settings/mount",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({connection_id:selConn.id})});if(r.ok){sv("download_dir",r.mount_path||mountPath);addToast(t.mountOk,"success");setPathResult({ok:true});if(refreshDisk)refreshDisk();}else{addToast(t.mountFail+(r.error?`: ${r.error}`:""  ),"error");}}catch(e){addToast(t.mountFail+": "+e.message,"error");}finally{setMounting(false);}}} style={{...sBtn,padding:"8px 16px",fontSize:12,background:`linear-gradient(135deg,${C.em},#059669)`}}>{mounting?<><I n="fa-solid fa-spinner fa-spin"/> {t.mounting}</>:<><I n="fa-solid fa-plug"/> {t.mountBtn}</>}</button>}{isMounted&&<button disabled={mounting} onClick={async()=>{if(!unmountConfirm){setUnmountConfirm(true);setTimeout(()=>setUnmountConfirm(false),3000);return;}setMounting(true);setUnmountConfirm(false);try{const r=await apiFetch("/api/settings/unmount",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:mountPath})});if(r.ok){sv("download_dir","");sv("default_storage","local");addToast(t.unmountOk,"success");setPathResult(null);if(refreshDisk)refreshDisk();}else{addToast(t.unmountFail+(r.error?`: ${r.error}`:""),"error");}}catch(e){addToast(t.unmountFail+": "+e.message,"error");}finally{setMounting(false);}}} style={{...sGhost,padding:"8px 16px",fontSize:12,border:`1px solid ${unmountConfirm?"rgba(239,68,68,0.6)":"rgba(239,68,68,0.3)"}`,borderRadius:12,color:unmountConfirm?"#fff":C.red,background:unmountConfirm?"linear-gradient(135deg,rgba(239,68,68,0.8),rgba(220,38,38,0.8))":"transparent",transition:"all .2s"}}>{mounting?<><I n="fa-solid fa-spinner fa-spin"/> {t.unmounting}</>:unmountConfirm?<><I n="fa-solid fa-triangle-exclamation"/> {t.unmountConfirm}</>:<><I n="fa-solid fa-eject"/> {t.unmountBtn}</>}</button>}</div>;})()}<div style={{marginTop:8,fontSize:10,color:C.muted}}><I n="fa-solid fa-circle-info" style={{marginRight:4}}/>{t.fstabInfo}</div><div style={{background:"rgba(0,0,0,0.3)",borderRadius:8,padding:8,marginTop:6,position:"relative"}}><code style={{fontSize:9,color:"#cbd5e1",fontFamily:"monospace",wordBreak:"break-all",lineHeight:1.5,display:"block",paddingRight:28}}>{fstabLine}</code><button onClick={async()=>{await copyToClipboard(fstabLine);addToast(t.mountCopy,"success");}} style={{position:"absolute",top:4,right:4,...sGhost,padding:"3px 5px",fontSize:9}}><I n="fa-solid fa-copy"/></button></div></>}</div>}<div style={{display:"flex",gap:8,alignItems:"flex-start"}}><input value={sn("download_dir","")} onChange={e=>sv("download_dir",e.target.value)} placeholder={t.storCustomPh} style={{...sInp,flex:1,fontFamily:"monospace",fontSize:12}}/><button disabled={testingPath||!sn("download_dir","").trim()} onClick={async()=>{const p=sn("download_dir","").trim();if(!p)return;setTestingPath(true);setPathResult(null);try{const r=await apiFetch("/api/settings/test-path",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})});setPathResult(r);}catch(e){setPathResult({ok:false,error:e.message});}finally{setTestingPath(false);}}} style={{...sGhost,padding:"8px 14px",border:"1px solid rgba(59,130,246,0.3)",borderRadius:12,fontSize:12,display:"flex",alignItems:"center",gap:6,opacity:testingPath||!sn("download_dir","").trim()?.5:1,flexShrink:0,color:"#93c5fd"}}>{testingPath?<I n="fa-solid fa-spinner fa-spin"/>:<I n="fa-solid fa-vial"/>}{testingPath?t.dlDirTesting:t.dlDirTest}</button></div>{pathResult&&<div style={{marginTop:8,background:pathResult.ok?"rgba(16,185,129,0.1)":"rgba(239,68,68,0.1)",border:`1px solid ${pathResult.ok?"rgba(16,185,129,0.3)":"rgba(239,68,68,0.3)"}`,borderRadius:10,padding:"8px 12px",fontSize:12,color:pathResult.ok?"#6ee7b7":"#fca5a5",display:"flex",alignItems:"center",gap:8}}><I n={pathResult.ok?"fa-solid fa-circle-check":"fa-solid fa-circle-exclamation"}/>{pathResult.ok?t.dlDirOk:(t.dlDirFail+(pathResult.error?`: ${pathResult.error.slice(0,80)}`:""))}</div>}<div style={{background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:10,padding:"8px 12px",marginTop:8,display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-triangle-exclamation" style={{color:C.amb,fontSize:11,flexShrink:0}}/><span style={{fontSize:10,color:"#fde68a",flex:1}}>{t.dlDirWarn}</span><button disabled={restarting} onClick={doRestart} style={{...sGhost,padding:"4px 10px",border:`1px solid ${restartArm?"rgba(239,68,68,0.6)":"rgba(245,158,11,0.3)"}`,borderRadius:8,fontSize:10,color:restartArm?"#fff":"#fde68a",background:restartArm?"rgba(239,68,68,0.7)":"transparent",display:"flex",alignItems:"center",gap:5,flexShrink:0,opacity:restarting?.5:1,transition:"all .2s"}}>{restarting?<I n="fa-solid fa-spinner fa-spin"/>:restartArm?<I n="fa-solid fa-triangle-exclamation"/>:<I n="fa-solid fa-rotate"/>}{restarting?t.restarting:restartArm?t.restartConfirm:t.restartBtn}</button></div></div>;})()}{isAct&&opt.val.startsWith("conn:")&&<div style={{background:"rgba(192,132,252,0.06)",borderRadius:"0 0 12px 12px",padding:"12px 12px 14px",marginBottom:8,border:"1px solid rgba(192,132,252,0.15)",borderTop:"none"}}>{ftpConns.length>1&&<div style={{marginBottom:10}}><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>FTP pripojenie</label><select value={ds} onChange={e=>svSilent("default_storage",e.target.value)} style={{...sInp,cursor:"pointer"}}>{ftpConns.map(cn=><option key={cn.id} value={`conn:${cn.id}`} style={{background:"#1a1d2e"}}>{cn.name} — {cn.host}</option>)}</select></div>}<div style={{background:"rgba(192,132,252,0.1)",border:"1px solid rgba(192,132,252,0.2)",borderRadius:10,padding:"8px 12px",display:"flex",alignItems:"flex-start",gap:8}}><I n="fa-solid fa-circle-info" style={{color:"#c084fc",fontSize:11,marginTop:2,flexShrink:0}}/><span style={{fontSize:10,color:"#d8b4fe"}}>{t.storFtpInfo}</span></div><div style={{marginTop:8}}><Tog value={sb("auto_cleanup",true)} onChange={v=>sv("auto_cleanup",v)} label={t.autoCleanup} sub={t.autoCleanupS}/></div></div>}</div>;})}
{!hasFtpC&&<div style={{background:"rgba(192,132,252,0.06)",borderRadius:12,padding:"10px 12px",marginTop:4,display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-globe" style={{color:"#c084fc",fontSize:11}}/><span style={{fontSize:10,color:"#d8b4fe"}}>{t.storFtp} — {t.storFtpNoConn}</span></div>}</>;})()} </Sec><Sec title={t.extConn} icon="fa-solid fa-plug">{connections.length===0&&<div style={{textAlign:"center",padding:"24px 0",color:C.muted}}><I n="fa-solid fa-plug-circle-xmark" style={{fontSize:28,marginBottom:8,display:"block"}}/><div style={{fontSize:13}}>{t.noExtConn}</div><div style={{fontSize:11,marginTop:4}}>{t.noExtConnH}</div></div>}{connections.map((conn)=>{const isTesting=testingConnId===conn.id;const clr=conn.type==="ftp"?"#c084fc":conn.type==="nfs"?"#f59e0b":"#22d3ee";const bg=conn.type==="ftp"?"rgba(192,132,252,0.15)":conn.type==="nfs"?"rgba(245,158,11,0.15)":"rgba(34,211,238,0.15)";const cIcon=conn.type==="ftp"?"fa-solid fa-globe":conn.type==="nfs"?"fa-solid fa-folder-tree":"fa-solid fa-network-wired";return<div key={conn.id||conn.name} style={{...glass,padding:12,borderRadius:12,marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:12}}><div style={{width:36,height:36,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",background:bg,flexShrink:0}}><I n={cIcon} style={{color:clr}}/></div><div style={{flex:1,minWidth:0}}><div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><span style={{fontSize:13,color:"#fff",fontWeight:500}}>{conn.name}</span>{conn.last_tested&&<span style={{fontSize:9,padding:"2px 7px",borderRadius:6,background:conn.online?"rgba(16,185,129,0.15)":"rgba(239,68,68,0.15)",color:conn.online?C.em:C.red,border:`1px solid ${conn.online?"rgba(16,185,129,0.3)":"rgba(239,68,68,0.3)"}`}}>{conn.online?t.online:t.offline}</span>}</div><div style={{fontSize:10,color:C.muted,marginTop:2,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{conn.type.toUpperCase()} — {conn.type==="nfs"?`${conn.host}:${conn.path||"/"}`:`${conn.host}${conn.type==="ftp"?`:${conn.port||21}`:""}/${conn.path||""}`}</div>{conn.last_tested&&<div style={{fontSize:9,color:"#4b5563",marginTop:3}}>{t.lastTest}: {new Date(conn.last_tested).toLocaleString()}</div>}</div><div style={{display:"flex",gap:4,flexShrink:0}}><button disabled={isTesting} onClick={async()=>{if(!conn.id)return;setTestingConnId(conn.id);try{const r=await apiFetch(`/api/connections/${conn.id}/test`,{method:"POST"});setConnections(p=>p.map(c=>c.id===conn.id?{...c,online:r.online,last_tested:r.last_tested}:c));addToast(r.online?t.connOnline:(t.connOffline+(r.error?`: ${r.error.slice(0,60)}`:"")),"info");}catch(e){addToast(e.message,"error");}finally{setTestingConnId(null);}}} style={{...sGhost,padding:"4px 10px",border:`1px solid rgba(255,255,255,0.08)`,borderRadius:10,fontSize:11,display:"flex",alignItems:"center",gap:5,opacity:isTesting?.6:1}}>{isTesting?<I n="fa-solid fa-spinner fa-spin"/>:<I n="fa-solid fa-plug"/>}{isTesting?t.connTesting:t.connTest}</button><button onClick={()=>{setEditingConnId(conn.id);setConnType(conn.type);setConnForm({name:conn.name,host:conn.host,port:String(conn.port||""),user:conn.user||"",pass:"",path:conn.path||""});setShowAddConn(true);setNewConnResult(null);}} style={{...sGhost,padding:"4px 8px",flexShrink:0}}><I n="fa-solid fa-pen" style={{color:C.muted}}/></button><button onClick={async()=>{if(conn.id){try{await apiFetch(`/api/connections/${conn.id}`,{method:"DELETE"});}catch{}}if(sn("default_storage","local")===`conn:${conn.id}`)svSilent("default_storage","local");setConnections(p=>p.filter(c=>conn.id?c.id!==conn.id:c.name!==conn.name));addToast(t.connRemoved,"info");}} style={{...sGhost,padding:"4px 8px",flexShrink:0}}><I n="fa-solid fa-trash" style={{color:C.red}}/></button></div></div></div>;})}{!showAddConn&&<div style={{display:"flex",gap:8,marginTop:connections.length>0?8:0}}><button onClick={()=>{setConnType("ftp");setConnForm({name:"",host:"",port:"21",user:"",pass:"",path:""});setEditingConnId(null);setShowAddConn(true);}} style={{flex:1,padding:10,borderRadius:12,border:"1px dashed rgba(192,132,252,0.4)",background:"rgba(192,132,252,0.05)",color:"#c084fc",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><I n="fa-solid fa-plus"/>{t.addFtp}</button><button onClick={()=>{setConnType("smb");setConnForm({name:"",host:"",port:"445",user:"",pass:"",path:""});setEditingConnId(null);setShowAddConn(true);}} style={{flex:1,padding:10,borderRadius:12,border:"1px dashed rgba(34,211,238,0.4)",background:"rgba(34,211,238,0.05)",color:"#22d3ee",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><I n="fa-solid fa-plus"/>{t.addSmb}</button><button onClick={()=>{setConnType("nfs");setConnForm({name:"",host:"",port:"2049",user:"",pass:"",path:""});setEditingConnId(null);setShowAddConn(true);}} style={{flex:1,padding:10,borderRadius:12,border:"1px dashed rgba(245,158,11,0.4)",background:"rgba(245,158,11,0.05)",color:"#f59e0b",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><I n="fa-solid fa-plus"/>{t.addNfs}</button></div>}{showAddConn&&<div style={{...glass,padding:16,borderRadius:12,marginTop:8}}><div style={{fontSize:11,color:connType==="ftp"?"#c084fc":connType==="nfs"?"#f59e0b":"#22d3ee",textTransform:"uppercase",letterSpacing:1,marginBottom:12,display:"flex",alignItems:"center",gap:8}}><I n={connType==="ftp"?"fa-solid fa-globe":connType==="nfs"?"fa-solid fa-folder-tree":"fa-solid fa-network-wired"}/>{connType.toUpperCase()} — {editingConnId?(t.editConn||"Edit connection"):t.addConn}</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><div style={{gridColumn:"1/-1"}}><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.connName}</label><input value={connForm.name} onChange={e=>setConnForm(p=>({...p,name:e.target.value}))} placeholder={connType==="ftp"?t.ftpNamePh:connType==="nfs"?t.nfsNamePh:t.smbNamePh} style={sInp}/></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.host}</label><input value={connForm.host} onChange={e=>setConnForm(p=>({...p,host:e.target.value}))} placeholder={connType==="ftp"?"ftp.example.com":connType==="nfs"?"192.168.1.50":"192.168.1.100"} style={sInp}/></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.connPort}</label><input value={connForm.port} onChange={e=>setConnForm(p=>({...p,port:e.target.value}))} placeholder={connType==="ftp"?"21":connType==="nfs"?"2049":"445"} style={sInp}/></div>{connType!=="nfs"&&<><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.connUser}</label><input value={connForm.user} onChange={e=>setConnForm(p=>({...p,user:e.target.value}))} placeholder={t.connUser.toLowerCase()} style={sInp}/></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.connPass}</label><input type="password" value={connForm.pass} onChange={e=>setConnForm(p=>({...p,pass:e.target.value}))} placeholder="••••••" style={sInp}/></div></>}<div style={{gridColumn:"1/-1"}}><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{connType==="ftp"?t.remotePath:connType==="nfs"?t.nfsExport:t.share}</label><input value={connForm.path} onChange={e=>setConnForm(p=>({...p,path:e.target.value}))} placeholder={connType==="ftp"?"/downloads":connType==="nfs"?"/export/data":"share"} style={sInp}/>{connType==="ftp"&&!connForm.path.trim()&&<div style={{fontSize:10,color:C.amb,marginTop:4,display:"flex",alignItems:"center",gap:4}}><I n="fa-solid fa-triangle-exclamation" style={{fontSize:9}}/>{t.ftpPathRequired}</div>}</div></div>{newConnResult&&<div style={{marginTop:8,background:newConnResult.online?"rgba(16,185,129,0.1)":"rgba(239,68,68,0.1)",border:`1px solid ${newConnResult.online?"rgba(16,185,129,0.3)":"rgba(239,68,68,0.3)"}`,borderRadius:10,padding:"8px 12px",fontSize:12,color:newConnResult.online?"#6ee7b7":"#fca5a5",display:"flex",alignItems:"center",gap:8}}><I n={newConnResult.online?"fa-solid fa-circle-check":"fa-solid fa-circle-exclamation"}/>{newConnResult.online?t.connOnline:(t.connOffline+(newConnResult.error?`: ${newConnResult.error.slice(0,80)}`:""))}</div>}<div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:12}}><button onClick={async()=>{if(!connForm.host.trim())return;setTestingNewConn(true);setNewConnResult(null);try{const r=await apiFetch("/api/connections/test-params",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:connType,host:connForm.host,port:connForm.port?parseInt(connForm.port):null,user:connForm.user||null,password:connForm.pass||null,path:connForm.path||null})});setNewConnResult(r);}catch(e){setNewConnResult({online:false,error:e.message});}finally{setTestingNewConn(false);}}} disabled={testingNewConn||!connForm.host.trim()} style={{...sGhost,padding:"8px 14px",border:`1px solid ${connType==="ftp"?"rgba(192,132,252,0.3)":connType==="nfs"?"rgba(245,158,11,0.3)":"rgba(34,211,238,0.3)"}`,borderRadius:10,fontSize:12,display:"flex",alignItems:"center",gap:6,opacity:testingNewConn||!connForm.host.trim()?.5:1,marginRight:"auto"}}>{testingNewConn?<I n="fa-solid fa-spinner fa-spin"/>:<I n="fa-solid fa-plug"/>}{testingNewConn?t.connTesting:t.connTest}</button><button onClick={()=>{setShowAddConn(false);setNewConnResult(null);setEditingConnId(null);}} style={sGhost}>{t.cancel}</button><button onClick={async()=>{if(!connForm.name.trim()||!connForm.host.trim())return;const payload={type:connType,name:connForm.name,host:connForm.host,port:connForm.port?parseInt(connForm.port):null,user:connForm.user||null,password:connForm.pass||null,path:connForm.path||null};try{if(editingConnId){const res=await apiFetch(`/api/connections/${editingConnId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});setConnections(p=>p.map(c=>c.id===editingConnId?res:c));addToast(t.connUpdated||"Connection updated","success");}else{const res=await apiFetch("/api/connections",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});setConnections(p=>[...p,res]);addToast(t.connAdded,"success");if(res.id){apiFetch(`/api/connections/${res.id}/test`,{method:"POST"}).then(tr=>{setConnections(p=>p.map(c=>c.id===res.id?{...c,online:tr.online,last_tested:tr.last_tested}:c));}).catch(()=>{});}}setShowAddConn(false);setNewConnResult(null);setEditingConnId(null);}catch(e){addToast(e.message,"error");}}} style={{...sBtn,padding:"8px 16px",fontSize:12}}>{editingConnId?<><I n="fa-solid fa-check"/> {t.save||"Save"}</>:<><I n="fa-solid fa-plus"/> {t.addConn}</>}</button></div></div>}</Sec></>}
    {tab==="categories"&&<Sec title={t.catMgmt} icon="fa-solid fa-tags"><div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>{categories.length===0&&<div style={{textAlign:"center",padding:"16px 0",color:C.muted,fontSize:13}}>{t.noCatYet}</div>}{categories.map(cat=><div key={cat.id||cat.name} style={{...glass,padding:12,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:16,height:16,borderRadius:5,background:cat.color,flexShrink:0,border:"1px solid rgba(255,255,255,0.15)"}}/><span style={{fontSize:13,color:"#fff"}}>{cat.name}</span></div><button onClick={async()=>{if(cat.id){try{await apiFetch(`/api/categories/${cat.id}`,{method:"DELETE"});}catch{}}setCategories(p=>p.filter(c=>cat.id?c.id!==cat.id:c.name!==cat.name));}} style={{...sGhost,padding:"4px 8px"}}><I n="fa-solid fa-trash" style={{color:C.red}}/></button></div>)}</div><div style={{...glass,padding:14,borderRadius:12}}><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-tag" style={{marginRight:4}}/>{t.catName}</label><input value={newCatName} onChange={e=>setNewCatName(e.target.value)} placeholder={t.catNamePh} style={sInp}/></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-palette" style={{marginRight:4}}/>{t.catColor}</label><div style={{display:"flex",flexWrap:"wrap",gap:5,padding:"6px 0"}}>{["#8b5cf6","#6366f1","#3b82f6","#06b6d4","#10b981","#84cc16","#f59e0b","#f97316","#ef4444","#ec4899"].map(clr=><div key={clr} onClick={()=>setNewCatColor(clr)} title={clr} style={{width:22,height:22,borderRadius:5,background:clr,cursor:"pointer",border:newCatColor===clr?"2px solid #fff":"2px solid transparent",transition:"transform .1s",transform:newCatColor===clr?"scale(1.2)":"scale(1)"}}/> )}</div></div></div><button onClick={async()=>{if(!newCatName.trim())return;try{const res=await apiFetch("/api/categories",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:newCatName.trim(),color:newCatColor})});setCategories(p=>[...p,res]);}catch(e){addToast(e.message,"error");}setNewCatName("");setNewCatColor("#8b5cf6");}} style={{...sBtn,width:"100%",padding:"9px 12px"}}><I n="fa-solid fa-plus"/> {t.addCat}</button></div></Sec>}
    {tab==="webhook"&&<Sec title={t.sWh} icon="fa-solid fa-tower-broadcast"><Tog value={sb("webhook_enabled",false)} onChange={v=>sv("webhook_enabled",v)} label={t.whEn} sub={t.whEnS}/>{sb("webhook_enabled",false)&&<div style={{marginTop:12,display:"flex",flexDirection:"column",gap:16}}><div style={{background:"rgba(139,92,246,0.1)",border:"1px solid rgba(139,92,246,0.2)",borderRadius:12,padding:"12px 16px"}}><div style={{fontSize:11,color:"#c4b5fd",marginBottom:4}}><I n="fa-solid fa-link"/> {t.whEnd}</div><div style={{display:"flex",alignItems:"center",gap:8}}><code style={{fontSize:12,color:"#fff",fontFamily:"monospace",flex:1,wordBreak:"break-all"}}>{webhookUrl}</code><button onClick={async()=>{await copyToClipboard(webhookUrl);addToast(t.urlCop,"success");}} style={{...sGhost,padding:"4px 8px"}}><I n="fa-solid fa-copy"/></button></div></div>{isHttp&&<div style={{background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:10,padding:"8px 12px",display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-triangle-exclamation" style={{color:C.amb,fontSize:11}}/><span style={{fontSize:10,color:"#fde68a"}}>{t.noSslNote}</span></div>}<div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-paper-plane"/> {t.whOutUrl}</label><input value={sn("webhook_url","")} onChange={e=>sv("webhook_url",e.target.value)} placeholder="https://..." style={sInp}/></div><div><div style={{fontSize:11,color:C.muted,marginBottom:8}}><I n="fa-solid fa-shield"/> {t.whAcc}</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>{[["pub","fa-globe",t.whPub,t.whPubS],["pass","fa-lock",t.whPass,t.whPassS]].map(([k,ic,l,d])=>{const active=(k==="pub"&&sd.webhook_secret!=="true")||(k==="pass"&&sd.webhook_secret==="true");return<button key={k} onClick={()=>sv("webhook_secret",k==="pass"?"true":"false")} style={{padding:12,borderRadius:12,border:`1px solid ${active?"rgba(139,92,246,0.3)":C.border}`,background:active?"rgba(139,92,246,0.15)":"rgba(255,255,255,0.02)",textAlign:"left",cursor:"pointer"}}><I n={`fa-solid ${ic}`} style={{fontSize:18,marginBottom:4,color:active?C.vioL:C.muted}}/><div style={{fontSize:13,color:"#fff"}}>{l}</div><div style={{fontSize:10,color:C.muted}}>{d}</div></button>;})}  </div>{sd.webhook_secret==="true"&&<div style={{marginTop:12}}><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-key"/> {t.whKey}</label><div style={{display:"flex",gap:8}}><input value={sn("webhook_key","")} onChange={e=>sv("webhook_key",e.target.value)} placeholder="bt_..." style={{...sInp,flex:1,fontFamily:"monospace"}}/><button onClick={()=>{sv("webhook_key","bt_"+Math.random().toString(36).slice(2,18));addToast(t.whKeyGen,"info");}} style={{...sGhost,border:`1px solid ${C.borderL}`,padding:"8px 16px",borderRadius:12}}><I n="fa-solid fa-rotate"/> {t.whGen}</button></div></div>}</div><div><div style={{fontSize:11,color:C.muted,marginBottom:8}}><I n="fa-solid fa-bell"/> {t.whEvt}</div>{[["added","fa-plus",t.whAdded],["progress","fa-bars-progress",t.whProg],["completed","fa-circle-check",t.whComp],["error","fa-circle-exclamation",t.whErr],["removed","fa-trash",t.whRem]].map(([k,ic,l])=><Tog key={k} value={whEvtObj[k]||false} onChange={v=>setWhEvt(k,v)} label={<span style={{display:"flex",alignItems:"center",gap:6}}><I n={`fa-solid ${ic}`} style={{color:C.muted,fontSize:11}}/>{l}</span>}/>)}</div></div>}</Sec>}
    {tab==="arr"&&<Sec title={t.arrTitle} icon="fa-solid fa-wand-magic-sparkles"><Tog value={sb("qbt_api_enabled",false)} onChange={v=>svSilent("qbt_api_enabled",v)} label={t.arrEn} sub={t.arrEnS}/>{sb("qbt_api_enabled",false)&&<div style={{marginTop:16,display:"flex",flexDirection:"column",gap:12}}><div style={{background:"rgba(139,92,246,0.08)",border:"1px solid rgba(139,92,246,0.2)",borderRadius:14,padding:16}}><div style={{fontSize:13,color:"#c4b5fd",fontWeight:600,marginBottom:12,display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-circle-info"/>{t.arrProfile}</div><div style={{display:"flex",flexDirection:"column",gap:10}}>{[{l:t.arrHost,v:typeof window!=="undefined"?window.location.hostname:"localhost",ic:"fa-server"},{l:t.arrPort,v:sn("web_port","8080"),ic:"fa-hashtag"},{l:t.arrUser,v:currentUser?.username||"admin",ic:"fa-user"},{l:t.arrPass,v:"("+t.arrPass+")",ic:"fa-key"}].map((f,i)=><div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",background:"rgba(0,0,0,0.2)",borderRadius:10}}><div style={{display:"flex",alignItems:"center",gap:8}}><I n={`fa-solid ${f.ic}`} style={{color:C.vioL,fontSize:12,width:16,textAlign:"center"}}/><span style={{fontSize:12,color:C.muted}}>{f.l}</span></div><span style={{fontSize:13,color:"#fff",fontFamily:i<3?"monospace":"inherit"}}>{f.v}</span></div>)}</div><div style={{display:"flex",alignItems:"center",gap:8,marginTop:12}}><button onClick={async()=>{const url=(typeof window!=="undefined"?window.location.protocol+"//"+window.location.hostname:"http://localhost")+":"+sn("web_port","8080");await copyToClipboard(url);addToast(t.urlCop,"success");}} style={{...sBtn,padding:"8px 16px",fontSize:12,flex:0}}><I n="fa-solid fa-copy"/> URL</button><code style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{(typeof window!=="undefined"?window.location.protocol+"//"+window.location.hostname:"http://localhost")+":"+sn("web_port","8080")}</code></div></div><div style={{background:"rgba(16,185,129,0.08)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-tags" style={{color:C.em,fontSize:12}}/><span style={{fontSize:12,color:"#6ee7b7"}}>{t.arrCat}</span></div></div>}</Sec>}
    {tab==="users"&&isA&&<Sec title={t.userMgmt} icon="fa-solid fa-users-gear"><div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>{users.map(usr=><div key={usr.id} style={{...glass,padding:16,borderRadius:12,opacity:usr.active?1:.5}}><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}><div style={{display:"flex",alignItems:"center",gap:12}}><div style={{width:40,height:40,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",background:usr.role==="admin"?"rgba(139,92,246,0.15)":"rgba(156,163,175,0.15)",color:usr.role==="admin"?C.vioL:C.muted}}><I n={usr.role==="admin"?"fa-solid fa-user-shield":"fa-solid fa-user"}/></div><div><div style={{fontSize:14,color:"#fff",fontWeight:500}}>{usr.username}{usr.role==="admin"&&<span style={{marginLeft:8,fontSize:8,background:"rgba(139,92,246,0.2)",color:"#c4b5fd",padding:"2px 8px",borderRadius:8,textTransform:"uppercase"}}>Admin</span>}</div><div style={{fontSize:10,color:C.muted}}>{usr.role==="admin"?t.fullPerm:t.limPerm}</div></div></div>{usr.role!=="admin"&&<div style={{display:"flex",gap:6}}><button onClick={async()=>{const na=!usr.active;try{await apiFetch(`/api/users/${usr.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({active:na})});}catch{}setUsers(p=>p.map(x=>x.id===usr.id?{...x,active:na}:x));}} style={{width:32,height:32,borderRadius:8,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,background:usr.active?"rgba(16,185,129,0.1)":"rgba(239,68,68,0.1)",color:usr.active?C.em:C.red}}><I n={usr.active?"fa-solid fa-circle-check":"fa-solid fa-circle-xmark"}/></button><button onClick={async()=>{try{await apiFetch(`/api/users/${usr.id}`,{method:"DELETE"});}catch{}setUsers(p=>p.filter(x=>x.id!==usr.id));addToast(t.usrRemoved,"info");}} style={{width:32,height:32,borderRadius:8,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,background:"rgba(239,68,68,0.1)",color:C.red}}><I n="fa-solid fa-trash"/></button></div>}</div>{usr.role!=="admin"&&<div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${C.border}`}}>{[{k:"download",ic:"fa-download",l:t.pDl,d:t.pDlS},{k:"upload",ic:"fa-upload",l:t.pUl,d:t.pUlS},{k:"external",ic:"fa-hard-drive",l:t.pExt,d:t.pExtS},{k:"webhook",ic:"fa-tower-broadcast",l:t.pWh,d:t.pWhS}].map(pm=><Tog key={pm.k} value={!!usr.perms[pm.k]} onChange={async v=>{const np={...usr.perms,[pm.k]:v};try{await apiFetch(`/api/users/${usr.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({perms:np})});}catch{}setUsers(pr=>pr.map(x=>x.id===usr.id?{...x,perms:np}:x));}} label={pm.l} sub={pm.d}/>)}</div>}</div>)}</div><AddUsr users={users} setUsers={setUsers} addToast={addToast}/></Sec>}
    {tab==="security"&&<><Sec title={t.secAcc} icon="fa-solid fa-lock"><Tog value={true} onChange={()=>{}} label={t.reqLogin} sub={t.reqLoginS}/><NIn label={t.sessTimeout} value={sn("session_timeout","1440")} onChange={v=>sv("session_timeout",v)} unit="min" sub={t.sessTimeoutS}/></Sec><Sec title={t.encrypt} icon="fa-solid fa-shield-halved"><Tog value={sb("force_encrypt",false)} onChange={v=>sv("force_encrypt",v)} label={t.forceEnc} sub={t.forceEncS}/><Tog value={sb("anon_mode",false)} onChange={v=>sv("anon_mode",v)} label={t.anon} sub={t.anonS}/></Sec><Sec title={t.ipFilt} icon="fa-solid fa-filter"><Tog value={sb("ip_filter",false)} onChange={v=>sv("ip_filter",v)} label={t.enIpFilt} sub={t.enIpFiltS}/><div style={{marginTop:10,opacity:sb("ip_filter",false)?1:0.4,transition:"opacity .2s"}}><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-list" style={{marginRight:4}}/>{t.ipList}</label><textarea value={sn("ip_filter_list","")} onChange={e=>sv("ip_filter_list",e.target.value)} placeholder={t.ipListPh} disabled={!sb("ip_filter",false)} style={{...sInp,minHeight:110,resize:"vertical",fontFamily:"monospace",fontSize:12,opacity:1}}/></div></Sec></>}
    {tab==="account"&&<><div style={{background:"rgba(255,255,255,0.04)",borderRadius:16,padding:16,border:`1px solid rgba(255,255,255,0.05)`,marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between",gap:14}}>
      <div style={{display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:52,height:52,borderRadius:"50%",background:"rgba(139,92,246,0.15)",border:`1px solid rgba(139,92,246,0.2)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <I n={currentUser?.role==="admin"?"fa-solid fa-user-shield":"fa-solid fa-user"} style={{color:C.vioL,fontSize:22}}/>
        </div>
        <div>
          <div style={{fontSize:16,fontWeight:600,color:"#fff"}}>{currentUser?.username}</div>
          <div style={{fontSize:12,color:C.muted,marginTop:3}}>{currentUser?.role==="admin"?t.accRoleAdmin:t.accRoleUser}</div>
        </div>
      </div>
      {onLogout&&<button onClick={onLogout} style={{...sGhost,padding:"8px 14px",borderRadius:12,border:`1px solid rgba(239,68,68,0.3)`,color:C.red,display:"flex",alignItems:"center",gap:6,fontSize:12,flexShrink:0}}><I n="fa-solid fa-right-from-bracket"/>{t.logout}</button>}
    </div>
    <Sec title={t.accChPass} icon="fa-solid fa-key">
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <div><label style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:6}}>{t.curPass}</label><input type="password" value={accCurPass} onChange={e=>{setAccCurPass(e.target.value);setAccErr("");setAccOk(false);}} placeholder={t.curPassPh} style={sInp}/></div>
        <div><label style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:6}}>{t.newPass}</label><input type="password" value={accNewPass} onChange={e=>{setAccNewPass(e.target.value);setAccErr("");setAccOk(false);}} placeholder={t.newPassPh} style={sInp}/></div>
        <div><label style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:6}}>{t.confirmPass}</label><input type="password" value={accConfPass} onChange={e=>{setAccConfPass(e.target.value);setAccErr("");setAccOk(false);}} placeholder={t.confirmPassPh} style={sInp}/></div>
        {accErr&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#fca5a5",display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-circle-exclamation"/>{accErr}</div>}
        {accOk&&<div style={{background:"rgba(16,185,129,0.1)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#6ee7b7",display:"flex",alignItems:"center",gap:8}}><I n="fa-solid fa-circle-check"/>{t.accSaved}</div>}
        <button onClick={async()=>{if(accNewPass.length<4){setAccErr(t.passShort);return;}if(accNewPass!==accConfPass){setAccErr(t.passNoMatch);return;}
          try{await apiFetch("/api/auth/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({current_password:accCurPass,new_password:accNewPass})});
            setAccOk(true);setAccCurPass("");setAccNewPass("");setAccConfPass("");addToast(t.accSaved,"success");
          }catch(ex){setAccErr(ex.message||t.passNoMatch);}}} style={{...sBtn,marginTop:4}}><I n="fa-solid fa-key"/> {t.accChPass}</button>
      </div>
    </Sec></>}
    {tab==="log"&&isA&&<Sec title={t.logTitle} icon="fa-solid fa-terminal"><div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}><button onClick={loadLogs} disabled={logsLoading} style={{...sGhost,padding:"4px 12px",borderRadius:8,fontSize:11,display:"flex",alignItems:"center",gap:5}}>{logsLoading?<I n="fa-solid fa-spinner fa-spin"/>:<I n="fa-solid fa-arrows-rotate"/>}{t.logRefresh}</button></div><div style={{background:"rgba(0,0,0,0.3)",borderRadius:12,padding:8,maxHeight:420,overflowY:"auto",fontFamily:"monospace",fontSize:11,lineHeight:1.6}}>{logs.length===0&&<div style={{textAlign:"center",padding:24,color:C.muted}}>{t.logEmpty}</div>}{[...logs].reverse().map((l,i)=>{const clr=l.level==="ERROR"?"#f87171":l.level==="WARNING"?"#fbbf24":"#9ca3af";const bg=l.level==="ERROR"?"rgba(248,113,113,0.06)":l.level==="WARNING"?"rgba(251,191,36,0.06)":"transparent";return<div key={i} style={{padding:"3px 8px",borderRadius:6,background:bg,display:"flex",gap:8,alignItems:"flex-start"}}><span style={{color:"#4b5563",flexShrink:0,fontSize:10,minWidth:68}}>{l.ts?l.ts.slice(11,19):""}</span><span style={{padding:"0 5px",borderRadius:4,fontSize:9,fontWeight:600,color:clr,background:l.level==="ERROR"?"rgba(248,113,113,0.12)":l.level==="WARNING"?"rgba(251,191,36,0.12)":"rgba(156,163,175,0.12)",flexShrink:0,lineHeight:"18px"}}>{l.level}</span><span style={{color:"#d1d5db",wordBreak:"break-all"}}>{l.msg}</span></div>;})}</div></Sec>}
    {tab==="about"&&<div style={{textAlign:"center",padding:"32px 0"}}><div style={{width:80,height:80,margin:"0 auto 16px",borderRadius:20,background:`linear-gradient(135deg,${C.vio},${C.ind})`,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 32px rgba(124,58,237,0.3)"}}><I n="fa-solid fa-hurricane" style={{fontSize:32,color:"#fff"}}/></div><h2 style={{fontSize:24,fontWeight:800,background:"linear-gradient(135deg,#c4b5fd,#93c5fd)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",margin:0}}>Bittora</h2><p style={{color:C.muted,fontSize:14,marginTop:4}}>v1.01 <span style={{fontSize:10,background:"rgba(245,158,11,0.15)",color:"#fbbf24",padding:"2px 8px",borderRadius:6,marginLeft:6,fontWeight:600,letterSpacing:1,textTransform:"uppercase"}}>BETA</span></p><p style={{color:"#4b5563",fontSize:11,marginTop:6,fontStyle:"italic"}}>Testing : Hardelone</p><div style={{marginTop:16,fontSize:14,color:C.muted}}><p>{t.built}</p><p>{t.wsRT}</p></div><div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap",marginTop:20}}><a href="https://ko-fi.com/hajdeo" target="_blank" rel="noopener noreferrer" style={{display:"inline-flex",alignItems:"center",gap:8,padding:"10px 20px",borderRadius:12,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)",color:"#fca5a5",fontSize:13,fontWeight:600,textDecoration:"none",transition:"all .2s"}} onMouseEnter={e=>{e.currentTarget.style.background="rgba(239,68,68,0.15)";e.currentTarget.style.borderColor="rgba(239,68,68,0.5)";}} onMouseLeave={e=>{e.currentTarget.style.background="rgba(239,68,68,0.08)";e.currentTarget.style.borderColor="rgba(239,68,68,0.3)";}}><I n="fa-solid fa-heart" style={{color:C.red}}/>Support Development</a><a href="https://github.com/HajDEO/Bittora" target="_blank" rel="noopener noreferrer" style={{display:"inline-flex",alignItems:"center",gap:8,padding:"10px 20px",borderRadius:12,border:`1px solid ${C.border}`,background:"rgba(255,255,255,0.04)",color:C.dim,fontSize:13,fontWeight:500,textDecoration:"none",transition:"all .2s"}} onMouseEnter={e=>{e.currentTarget.style.background="rgba(139,92,246,0.1)";e.currentTarget.style.borderColor="rgba(139,92,246,0.3)";e.currentTarget.style.color="#a78bfa";}} onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,0.04)";e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.dim;}}><I n="fa-brands fa-github"/>GitHub</a></div><p style={{fontSize:12,color:"#4b5563",marginTop:16,display:"flex",alignItems:"center",justifyContent:"center",gap:6,flexWrap:"wrap"}}>© {new Date().getFullYear()} Bittora <I n="fa-solid fa-heart" style={{color:C.red,fontSize:10}}/> <a href="https://boostuj.sk" target="_blank" rel="noopener noreferrer" style={{color:"#6b7280",textDecoration:"none"}} onMouseEnter={e=>e.target.style.color="#a78bfa"} onMouseLeave={e=>e.target.style.color="#6b7280"}>BOOSTUJ.SK</a><span style={{color:"#374151"}}>·</span><a href="mailto:info@bittora.online" style={{color:"#6b7280",textDecoration:"none",display:"inline-flex",alignItems:"center",gap:4}} onMouseEnter={e=>e.target.style.color="#a78bfa"} onMouseLeave={e=>e.target.style.color="#6b7280"}><I n="fa-solid fa-envelope" style={{fontSize:9}}/>info@bittora.online</a></p></div>}
    {tab==="rss"&&<Sec title={t.rssFeeds} icon="fa-solid fa-rss">{rssFeeds.length===0&&!showAddRss&&<div style={{textAlign:"center",padding:"24px 0",color:C.muted}}><I n="fa-solid fa-rss" style={{fontSize:28,marginBottom:8,display:"block",color:"#374151"}}/><div style={{fontSize:13}}>{t.rssNoFeeds}</div><div style={{fontSize:11,marginTop:4}}>{t.rssNoFeedsH}</div></div>}{rssFeeds.map(f=><div key={f.id} style={{background:"rgba(255,255,255,0.03)",borderRadius:12,padding:12,marginBottom:8,display:"flex",alignItems:"flex-start",gap:10}}><div style={{flex:1}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}><span style={{fontSize:14,color:"#fff",fontWeight:500}}>{f.name}</span>{f.auto_dl&&<span style={{fontSize:9,background:"rgba(16,185,129,0.1)",color:C.em,padding:"2px 8px",borderRadius:8,flexShrink:0}}>{t.autoDl}</span>}</div><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:4,wordBreak:"break-all"}}>{f.url}</div><div style={{display:"flex",gap:12,fontSize:10,color:C.muted}}><span><I n="fa-solid fa-clock"/> {f.interval}min</span>{f.filter&&<span><I n="fa-solid fa-filter"/> {f.filter}</span>}<span><I n="fa-solid fa-file"/> {f.matches||0} {t.matches}</span></div></div><button onClick={async()=>{try{await apiFetch(`/api/rss/${f.id}`,{method:"DELETE"});}catch{}setRssFeeds(p=>p.filter(x=>x.id!==f.id));addToast(t.rssRemoved,"info");}} style={{...sGhost,padding:"4px 8px",flexShrink:0}}><I n="fa-solid fa-trash" style={{color:C.red}}/></button></div>)}{!showAddRss&&<button onClick={()=>setShowAddRss(true)} style={{width:"100%",padding:10,borderRadius:12,border:`1px dashed ${C.border}`,background:"transparent",color:C.muted,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginTop:rssFeeds.length>0?8:0}}><I n="fa-solid fa-plus"/> {t.addRss}</button>}{showAddRss&&<div style={{...glass,padding:16,borderRadius:12,marginTop:8}}><div style={{display:"flex",flexDirection:"column",gap:10}}><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.rssUrl}</label><input value={rssForm.url} onChange={e=>setRssForm(p=>({...p,url:e.target.value}))} placeholder="https://example.com/rss" style={sInp}/></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.rssName}</label><input value={rssForm.name} onChange={e=>setRssForm(p=>({...p,name:e.target.value}))} placeholder={t.rssName} style={sInp}/></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.rssInt}</label><input type="number" min="5" value={rssForm.interval} onChange={e=>setRssForm(p=>({...p,interval:parseInt(e.target.value)||30}))} style={sInp}/></div></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.rssFilt}</label><input value={rssForm.filter} onChange={e=>setRssForm(p=>({...p,filter:e.target.value}))} placeholder="Ubuntu|Fedora" style={sInp}/></div><Tog value={rssForm.auto_dl} onChange={v=>setRssForm(p=>({...p,auto_dl:v}))} label={t.autoDlM} sub={t.autoDlS}/><div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:4}}><button onClick={()=>setShowAddRss(false)} style={sGhost}>{t.cancel}</button><button onClick={async()=>{if(!rssForm.url.trim()||!rssForm.name.trim())return;try{const res=await apiFetch("/api/rss",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:rssForm.url.trim(),name:rssForm.name.trim(),filter:rssForm.filter,interval:rssForm.interval,auto_dl:rssForm.auto_dl})});setRssFeeds(p=>[...p,res]);addToast(t.rssAdded,"success");setShowAddRss(false);setRssForm({url:"",name:"",filter:"",interval:30,auto_dl:false});}catch(e){addToast(e.message,"error");}}} style={{...sBtn,padding:"8px 16px",fontSize:12}}><I n="fa-solid fa-plus"/> {t.addRss}</button></div></div></div>}</Sec>}
    {tab==="scheduler"&&(()=>{
      const schedData=(()=>{try{const p=JSON.parse(sn("sched_schedule","[]"));return Array.isArray(p)&&p.length===24?p:Array.from({length:24},()=>Array(7).fill(false));}catch{return Array.from({length:24},()=>Array(7).fill(false));}})();
      const toggleSchedCell=(h,d)=>{const n=schedData.map((row,ri)=>ri===h?row.map((v,di)=>di===d?!v:v):row);sv("sched_schedule",JSON.stringify(n));};
      return<><Sec title={t.schedTitle} icon="fa-solid fa-calendar-days">
        <Tog value={sb("sched_enabled",false)} onChange={v=>sv("sched_enabled",v)} label={t.schedEn} sub={t.schedEnS}/>
        <div style={{marginTop:12,background:"rgba(255,255,255,0.02)",borderRadius:12,padding:16,overflowX:"auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:10,fontSize:10,color:C.muted}}>
            <div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:14,height:14,borderRadius:3,background:"rgba(16,185,129,0.35)",border:"1px solid rgba(16,185,129,0.5)"}}/>{t.limited}</div>
            <div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:14,height:14,borderRadius:3,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)"}}/>{t.full}</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"28px repeat(7,1fr)",gap:2,textAlign:"center",fontSize:9,minWidth:280}}>
            <div/>
            {t.schedDays.split(",").map(d=><div key={d} style={{color:C.muted,fontWeight:600,padding:"4px 0",fontSize:10}}>{d}</div>)}
            {Array.from({length:24},(_,h)=>[
              <div key={`h${h}`} style={{color:C.muted,padding:"2px 0",textAlign:"right",paddingRight:4,fontSize:9,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>{String(h).padStart(2,"0")}</div>,
              ...Array.from({length:7},(_,d)=>{
                const on=schedData[h]&&schedData[h][d];
                return<div key={`${h}-${d}`} onClick={()=>toggleSchedCell(h,d)} style={{borderRadius:3,cursor:"pointer",minHeight:10,background:on?"rgba(16,185,129,0.35)":"rgba(255,255,255,0.04)",border:on?"1px solid rgba(16,185,129,0.4)":"1px solid transparent",transition:"background .1s"}}/>;
              })
            ]).flat()}
          </div>
        </div>
      </Sec>
      <Sec title={t.altLim} icon="fa-solid fa-gauge"><NIn label={t.altDL} value={sn("sched_alt_dl","500")} onChange={v=>sv("sched_alt_dl",v)} unit="KB/s"/><NIn label={t.altUL} value={sn("sched_alt_ul","100")} onChange={v=>sv("sched_alt_ul",v)} unit="KB/s"/></Sec></>;
    })()}
  </>;

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:isMob?0:16}} onClick={onClose}>
      <div style={{...glass,width:"100%",maxWidth:720,height:isMob?"100dvh":"85vh",display:"flex",flexDirection:"column",borderRadius:isMob?0:20}} onClick={e=>e.stopPropagation()}>

        {/* ── Header ── */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMob?"13px 16px":"18px 20px",borderBottom:`1px solid ${C.border}`,flexShrink:0,minHeight:56}}>
          {isMob&&!mobShowList
            ?<button onClick={()=>setMobShowList(true)} style={{...sGhost,display:"flex",alignItems:"center",gap:6,padding:"4px 0",fontSize:16,color:"#a78bfa",fontWeight:600}}>
               <I n="fa-solid fa-chevron-left" style={{fontSize:13}}/> {tabs.find(x=>x.k===tab)?.l}
             </button>
            :<h2 style={{fontSize:18,fontWeight:600,color:"#fff",display:"flex",alignItems:"center",gap:8,margin:0}}><I n="fa-solid fa-gear" style={{color:C.vioL}}/> {t.settings}</h2>
          }
          <button onClick={onClose} style={{...sGhost,width:32,height:32,padding:0,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:8,marginLeft:"auto",flexShrink:0}}><I n="fa-solid fa-xmark"/></button>
        </div>

        {/* ── MOBILE: zoznam sekcií ── */}
        {isMob&&mobShowList&&
          <div style={{flex:1,overflowY:"auto"}}>
            {tabs.map(x=><button key={x.k} onClick={()=>{setTab(x.k);setMobShowList(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"15px 16px",border:"none",borderBottom:`1px solid ${C.border}`,background:"transparent",cursor:"pointer",textAlign:"left"}}>
              <div style={{width:38,height:38,borderRadius:11,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(255,255,255,0.05)",flexShrink:0}}>
                <I n={`fa-solid ${x.ic}`} style={{fontSize:15,color:C.muted}}/>
              </div>
              <span style={{fontSize:15,color:C.text,flex:1}}>{x.l}</span>
              <I n="fa-solid fa-chevron-right" style={{color:C.muted,fontSize:11,flexShrink:0}}/>
            </button>)}
          </div>
        }

        {/* ── MOBILE: obsah sekcie  /  DESKTOP: sidebar + obsah ── */}
        {(!isMob||(isMob&&!mobShowList))&&<>
          <div style={{display:"flex",flex:1,overflow:"hidden"}}>
            {!isMob&&<div style={{width:180,borderRight:`1px solid ${C.border}`,padding:8,overflowY:"auto",flexShrink:0}}>
              {tabs.map(x=><button key={x.k} onClick={()=>setTab(x.k)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,fontSize:13,border:"none",cursor:"pointer",marginBottom:2,background:tab===x.k?"rgba(139,92,246,0.15)":"transparent",color:tab===x.k?"#a78bfa":C.muted,textAlign:"left"}}><I n={`fa-solid ${x.ic}`} style={{fontSize:11,width:16,textAlign:"center"}}/>{x.l}</button>)}
            </div>}
            <div style={{flex:1,overflowY:"auto",padding:isMob?"14px 16px":20,overflowX:"hidden"}}>
              {TabContent()}
            </div>
          </div>
          <div style={{display:"flex",gap:12,padding:isMob?"12px 16px":"14px 20px",borderTop:`1px solid ${C.border}`,flexShrink:0}}>
            <button onClick={onClose} style={{...sGhost,flex:isMob?1:0,padding:isMob?"10px":"8px 16px",...(isMob?{border:`1px solid ${C.border}`,borderRadius:12,color:C.text}:{})}}>{t.cancel}</button>
            <button onClick={doSave} disabled={saving} style={{...sBtn,padding:isMob?"10px":"10px 24px",...(isMob?{flex:1}:{}),opacity:saving?.7:1}}>{saving?<><I n="fa-solid fa-spinner fa-spin"/> {t.saving}</>:<><I n="fa-solid fa-floppy-disk"/> {t.save}</>}</button>
          </div>
        </>}

      </div>
    </div>
  );
};
const AddUsr=({users,setUsers,addToast})=>{const{t}=useT();const[s,setS]=useState(false);const[n,setN]=useState("");const[p,setP]=useState("");const[ld,setLd]=useState(false);
  const add=async()=>{if(!n.trim()||!p.trim()){addToast(t.fillBoth,"warning");return;}setLd(true);
    try{const res=await apiFetch("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:n.trim(),password:p})});
      setUsers(pr=>[...pr,{id:res.id,username:res.username,role:"user",perms:{download:true,upload:false,external:false,webhook:false},active:true}]);
      addToast(`${n.trim()} ${t.usrCreated}`,"success");setN("");setP("");setS(false);
    }catch(e){addToast(e.message||t.usrExists,"error");}finally{setLd(false);}};
  if(!s)return<button onClick={()=>setS(true)} style={{width:"100%",padding:10,borderRadius:12,border:`1px dashed ${C.border}`,background:"transparent",color:C.muted,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><I n="fa-solid fa-user-plus"/> {t.addUsr}</button>;
  return<div style={{...glass,padding:16,borderRadius:12}}><div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}><I n="fa-solid fa-user-plus"/> {t.newUsr}</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.usrName}</label><input value={n} onChange={e=>setN(e.target.value)} placeholder={t.usrName} style={sInp}/></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:4}}>{t.loginPass}</label><input type="password" value={p} onChange={e=>setP(e.target.value)} placeholder="••••••" style={sInp}/></div></div><div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:12}}><button onClick={()=>setS(false)} style={sGhost}>{t.cancel}</button><button onClick={add} disabled={ld} style={{...sBtn,padding:"8px 16px",fontSize:12,opacity:ld?.6:1}}>{ld?<I n="fa-solid fa-spinner fa-spin"/>:<><I n="fa-solid fa-plus"/> {t.create}</>}</button></div></div>;};

/* ═══════════════ DELETE FILES OPTION ═══════════════ */
const DeleteFilesOption=({onSelect})=>{
  const{t}=useT();
  const[delFiles,setDelFiles]=useState(false);
  return<div style={{display:"flex",flexDirection:"column",gap:10}}>
    {[[false,t.delOptList,t.delOptListS,"fa-list"],
      [true,t.delOptFiles,t.delOptFilesS,"fa-hard-drive"]
    ].map(([val,label,sub,ic])=><button key={String(val)} onClick={()=>setDelFiles(val)} style={{display:"flex",alignItems:"center",gap:12,padding:12,borderRadius:12,border:`1px solid ${delFiles===val?"rgba(139,92,246,0.4)":C.border}`,background:delFiles===val?"rgba(139,92,246,0.1)":"rgba(255,255,255,0.02)",cursor:"pointer",textAlign:"left"}}>
      <div style={{width:32,height:32,borderRadius:9,background:delFiles===val?"rgba(139,92,246,0.2)":"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><I n={`fa-solid ${ic}`} style={{fontSize:13,color:delFiles===val?C.vioL:C.muted}}/></div>
      <div><div style={{fontSize:13,color:"#fff",fontWeight:500}}>{label}</div><div style={{fontSize:11,color:C.muted,marginTop:2}}>{sub}</div></div>
      <div style={{marginLeft:"auto",width:16,height:16,borderRadius:"50%",border:`2px solid ${delFiles===val?C.vioL:C.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{delFiles===val&&<div style={{width:8,height:8,borderRadius:"50%",background:C.vioL}}/>}</div>
    </button>)}
    <button onClick={()=>onSelect(delFiles)} style={{...sBtn,marginTop:4,background:delFiles?"linear-gradient(135deg,#ef4444,#dc2626)":"linear-gradient(135deg,#7c3aed,#4f46e5)"}}>
      <I n="fa-solid fa-trash"/> {t.remove}
    </button>
  </div>;
};

/* ═══════════════ ADD TORRENT MODAL ═══════════════ */
const AddTorrentModal=({isOpen,onClose,onAdd,addToast,categories,connections=[],defaultStorage="local",disk})=>{const{t}=useT();const resolveDefStor=(ds)=>{if(!ds||ds==="local")return"local";if(ds==="custom")return"custom";if(ds.startsWith("conn:")){const cid=parseInt(ds.split(":")[1]);const cn=connections.find(c=>c.id===cid);return cn?cn.type:"local";}return"local";};const[tab,setTab]=useState("magnet");const[magnetText,setMagnetText]=useState("");const[category,setCategory]=useState("");const[destination,setDestination]=useState(()=>resolveDefStor(defaultStorage));const[startImm,setStartImm]=useState(true);const[files,setFiles]=useState([]);const[trackers,setTrackers]=useState("");const[showTrackers,setShowTrackers]=useState(false);const[adding,setAdding]=useState(false);const[addErr,setAddErr]=useState("");const[dlLimit,setDlLimit]=useState("0");const[ulLimit,setUlLimit]=useState("0");const fileInputRef=useRef(null);
  const hasFtp=connections.some(c=>c.type==="ftp");
  const hasSmb=connections.some(c=>c.type==="smb");
  const applyLimits=async(hashes)=>{const dl=parseInt(dlLimit)||0;const ul=parseInt(ulLimit)||0;if(dl>0||ul>0){for(const ih of hashes){try{await apiFetch(`/api/torrents/${ih}/limits`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({download_limit:dl,upload_limit:ul})});}catch(e){}}}};
  const handleAddTorrents=async()=>{if(adding)return;setAdding(true);setAddErr("");
    try{
      if(tab==="magnet"&&magnetText.trim()){
        const realDest=destination==="custom"&&disk?.mounts?.length>0?(disk.mounts[0].fstype==="cifs"||disk.mounts[0].source?.startsWith("//")?"smb":"nfs"):destination;
        const fd=new FormData();fd.append("magnet",magnetText.trim());fd.append("destination",realDest);fd.append("category",category);fd.append("trackers",trackers);
        const added=await apiFetch("/api/torrents/add",{method:"POST",body:fd});
        if(!added.length){setAddErr(t.noMagnets);setAdding(false);return;}
        await applyLimits(added.map(a=>a.info_hash));
        onAdd(added.length); setMagnetText("");
      } else if(tab==="file"&&files.length){
        const allHashes=[];
        const realDest2=destination==="custom"&&disk?.mounts?.length>0?(disk.mounts[0].fstype==="cifs"||disk.mounts[0].source?.startsWith("//")?"smb":"nfs"):destination;
        for(const f of files){const fd=new FormData();fd.append("file",f);fd.append("destination",realDest2);fd.append("category",category);fd.append("trackers",trackers);const res=await apiFetch("/api/torrents/add",{method:"POST",body:fd});if(res.length)allHashes.push(res[0].info_hash);}
        await applyLimits(allHashes);
        onAdd(files.length); setFiles([]);
      } else {setAdding(false);return;}
      onClose();
    }catch(ex){setAddErr(ex.message||t.addError);}finally{setAdding(false);} };const handleDrop=e=>{e.preventDefault();const droppedFiles=Array.from(e.dataTransfer.files).filter(f=>f.name.endsWith(".torrent"));setFiles(p=>[...p,...droppedFiles]);};return isOpen?(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50,padding:16}} onClick={onClose}><div style={{...glass,width:"100%",maxWidth:540,maxHeight:"90dvh",borderRadius:20,display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}><div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:20,borderBottom:`1px solid ${C.border}`,flexShrink:0}}><h2 style={{fontSize:18,fontWeight:600,color:"#fff",display:"flex",alignItems:"center",gap:8,margin:0}}><I n="fa-solid fa-plus" style={{color:C.vioL}}/> {t.addTorrent}</h2><button onClick={onClose} style={{...sGhost,width:32,height:32,padding:0,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:8}}><I n="fa-solid fa-xmark"/></button></div><div style={{padding:20,overflowY:"auto",flex:1,WebkitOverflowScrolling:"touch"}}><div style={{display:"flex",gap:8,marginBottom:16}}>{["magnet","file"].map(t_=><button key={t_} onClick={()=>setTab(t_)} style={{flex:1,padding:10,borderRadius:12,border:`1px solid ${tab===t_?"rgba(139,92,246,0.4)":C.border}`,background:tab===t_?"rgba(139,92,246,0.15)":"transparent",color:tab===t_?"#a78bfa":C.muted,fontSize:13,fontWeight:500,cursor:"pointer"}}>{t_==="magnet"?t.addMagnet:t.addFile}</button>)}</div>{tab==="magnet"?<div style={{display:"flex",flexDirection:"column",gap:12}}><label style={{fontSize:11,color:C.muted,display:"block"}}><I n="fa-solid fa-link"/> {t.addMagnet}</label><textarea value={magnetText} onChange={e=>setMagnetText(e.target.value)} placeholder={t.magnetPh} style={{...sInp,minHeight:120,resize:"none",fontFamily:"monospace",fontSize:12}}/></div>:<div style={{display:"flex",flexDirection:"column",gap:12}}><input type="file" accept=".torrent" multiple ref={fileInputRef} style={{display:"none"}} onChange={e=>{const f=Array.from(e.target.files).filter(x=>x.name.endsWith(".torrent"));setFiles(p=>[...p,...f]);e.target.value="";}}/>
<div onDragOver={e=>e.preventDefault()} onDrop={handleDrop} onClick={()=>fileInputRef.current?.click()} style={{border:`2px dashed ${C.borderL}`,borderRadius:12,padding:24,textAlign:"center",cursor:"pointer",background:"rgba(139,92,246,0.05)"}}><I n="fa-solid fa-cloud-arrow-up" style={{fontSize:28,color:C.muted,marginBottom:8,display:"block"}}/><p style={{color:C.text,margin:"8px 0 4px"}}>{t.dropzone}</p><p style={{color:C.muted,fontSize:11,margin:0}}>{files.length>0?`${files.length} ${t.filesSelected}`:t.browse}</p></div>{files.length>0&&<div style={{background:"rgba(255,255,255,0.03)",borderRadius:12,padding:12,maxHeight:120,overflowY:"auto"}}>{files.map((f,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",fontSize:12,color:C.text,borderBottom:`1px solid rgba(255,255,255,0.03)`}}><span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span><button onClick={()=>setFiles(p=>p.filter((_,x)=>x!==i))} style={{...sGhost,padding:"2px 4px",fontSize:10}}><I n="fa-solid fa-trash"/></button></div>)}</div>}</div>}<div style={{marginTop:16,display:"flex",flexDirection:"column",gap:12}}><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-folder"/> {t.selCat}</label><select value={category} onChange={e=>setCategory(e.target.value)} style={{...sInp,cursor:"pointer"}}><option value="" style={{background:"#1a1d2e"}}>{t.noCat}</option>{categories.map(cat=><option key={cat.name} value={cat.name} style={{background:"#1a1d2e"}}>{cat.name}</option>)}</select></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-map-location-dot"/> {t.selDest}</label><select value={destination} onChange={e=>setDestination(e.target.value)} style={{...sInp,cursor:"pointer"}}><option value="local" style={{background:"#1a1d2e"}}>{t.dLocal}</option>{disk?.mounts?.length>0?disk.mounts.map(m=>{const isSMB=m.fstype==="cifs"||m.source?.startsWith("//");const connMatch=connections.find(c=>(c.type==="smb"||c.type==="nfs")&&m.name===c.name.replace(/[^a-zA-Z0-9]/g,'-').toLowerCase());return<option key={m.path} value="custom" style={{background:"#1a1d2e"}}>{isSMB?"SMB":"NFS"} — {connMatch?connMatch.name:m.name}</option>;}):<option value="custom" style={{background:"#1a1d2e"}}>{t.dCustom}</option>}{hasFtp&&<option value="ftp" style={{background:"#1a1d2e"}}>{t.dFTP}</option>}</select></div><div><label style={{fontSize:11,color:C.muted,display:"block",marginBottom:6}}><I n="fa-solid fa-gauge"/> {t.torLim}</label><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}><div><label style={{fontSize:10,color:C.muted,display:"block",marginBottom:4}}><I n="fa-solid fa-arrow-down" style={{color:C.em,marginRight:3}}/>{t.maxDL} KB/s</label><input type="number" min="0" value={dlLimit} onChange={e=>setDlLimit(e.target.value)} style={{...sInp,padding:"6px 10px",fontSize:12,textAlign:"right"}}/></div><div><label style={{fontSize:10,color:C.muted,display:"block",marginBottom:4}}><I n="fa-solid fa-arrow-up" style={{color:C.vioL,marginRight:3}}/>{t.maxUL} KB/s</label><input type="number" min="0" value={ulLimit} onChange={e=>setUlLimit(e.target.value)} style={{...sInp,padding:"6px 10px",fontSize:12,textAlign:"right"}}/></div></div><div style={{fontSize:10,color:"#4b5563",marginTop:4}}>{t.unlim}</div></div><Tog value={startImm} onChange={setStartImm} label={t.startNow}/><div style={{marginTop:8}}><button type="button" onClick={()=>setShowTrackers(p=>!p)} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",cursor:"pointer",padding:"6px 0",fontSize:12,color:showTrackers?C.vioL:C.muted,width:"100%",textAlign:"left"}}><I n={`fa-solid ${showTrackers?"fa-chevron-down":"fa-chevron-right"}`} style={{fontSize:9}}/><I n="fa-solid fa-tower-broadcast" style={{fontSize:11}}/>{t.addTrackers}</button>{showTrackers&&<textarea value={trackers} onChange={e=>setTrackers(e.target.value)} placeholder={t.trackersPh} style={{...sInp,marginTop:4,minHeight:80,resize:"vertical",fontFamily:"monospace",fontSize:11}}/>}</div></div>{addErr&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#fca5a5",display:"flex",alignItems:"center",gap:8,marginTop:8}}><I n="fa-solid fa-circle-exclamation"/>{addErr}</div>}<div style={{display:"flex",justifyContent:"flex-end",gap:12,marginTop:16}}><button onClick={onClose} style={sGhost}>{t.cancel}</button><button onClick={handleAddTorrents} disabled={adding} style={{...sBtn,padding:"10px 24px",opacity:adding?.6:1}}>{adding?<><I n="fa-solid fa-spinner fa-spin"/> {t.saving}</>:<><I n="fa-solid fa-check"/> {t.addBtn}</>}</button></div></div></div></div>):null;};

/* ═══════════════ MAIN APP ═══════════════ */
export default function App(){
  const[authChecking,setAuthChecking]=useState(true);
  const[loggedIn,setLoggedIn]=useState(false);const[curUser,setCurUser]=useState(null);
  const[users,setUsers]=useState([]);const[torrents,setTorrents]=useState([]);
  const[disk,setDisk]=useState(null);const[appSettings,setAppSettings]=useState({});
  const[showSet,setShowSet]=useState(false);const[showSetTab,setShowSetTab]=useState("general");const[toasts,setToasts]=useState([]);
  const[filter,setFilter]=useState("all");const[sel,setSel]=useState(new Set());
  const[search,setSearch]=useState("");const[sidebar,setSidebar]=useState(()=>typeof window!=="undefined"?window.innerWidth>640:true);
  const[detail,setDetail]=useState(null);const[lang,setLang]=useState("sk");
  const[showAdd,setShowAdd]=useState(false);const[mobSearch,setMobSearch]=useState(false);
  const[deleteConfirm,setDeleteConfirm]=useState(null); // {ids:[...], names:[...]} or null
  const[categories,setCategories]=useState([]);
  const[connections,setConnections]=useState([]);
  const[winW,setWinW]=useState(()=>typeof window!=="undefined"?window.innerWidth:1024);
  const wsRef=useRef(null);const prevTorrentsRef=useRef({});
  const t=LANGS[lang];
  const isMob=winW<=640;

  useEffect(()=>{injectDark();loadFA();},[]);
  useEffect(()=>{const h=()=>setWinW(window.innerWidth);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);
  useEffect(()=>{if(detail){document.body.style.overflow="hidden";}else{document.body.style.overflow="";}return()=>{document.body.style.overflow="";};},[detail]);
  // Sync open detail panel with latest WS data
  useEffect(()=>{if(!detail)return;const u=torrents.find(x=>x.info_hash===detail.info_hash);if(u)setDetail(u);},[torrents]);// eslint-disable-line react-hooks/exhaustive-deps
  const addToast=useCallback((m,ty="info")=>setToasts(p=>[...p,{id:Date.now()+Math.random(),message:m,type:ty}]),[]);
  const rmToast=useCallback(id=>setToasts(p=>p.filter(x=>x.id!==id)),[]);

  // ─── Auth check on startup ───
  useEffect(()=>{
    apiFetch("/api/auth/me")
      .then(d=>{setCurUser(d);setLoggedIn(true);setAuthChecking(false);})
      .catch(()=>setAuthChecking(false));
  },[]);

  // ─── WebSocket ───
  const connectWS=useCallback(()=>{
    const proto=window.location.protocol==="https:"?"wss:":"ws:";
    const ws=new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onmessage=e=>{
      const msg=JSON.parse(e.data);
      if(msg.type==="update"){
        setTorrents(prev=>{
          const prevMap={};prev.forEach(x=>{prevMap[x.info_hash]=x;});
          return msg.torrents.map(t=>{
            const p=prevMap[t.info_hash];
            const mapped=wsToTorrent(t);
            if(p&&p.status!=="completed"&&mapped.status==="completed")
              addToast(`${mapped.name} — ${LANGS[lang].tDone}`,"success");
            return mapped;
          });
        });
      }
    };
    ws.onclose=ev=>{if(ev.code!==4001&&ev.code!==1000)setTimeout(connectWS,3000);};
    ws.onerror=()=>ws.close();
    wsRef.current=ws;
  },[addToast,lang]);

  // ─── Handle session expiry mid-session ───
  const handleApiError=useCallback(err=>{
    if(err.status===401){setCurUser(null);setLoggedIn(false);setTorrents([]);}
  },[]);

  useEffect(()=>{
    if(!loggedIn)return;
    connectWS();
    apiFetch("/api/categories").then(setCategories).catch(handleApiError);
    apiFetch("/api/disk").then(setDisk).catch(handleApiError);
    apiFetch("/api/users").then(setUsers).catch(()=>{});
    apiFetch("/api/connections").then(setConnections).catch(()=>{});
    apiFetch("/api/settings").then(s=>setAppSettings(s||{})).catch(()=>{});
    const diskIv=setInterval(()=>{apiFetch("/api/disk").then(setDisk).catch(()=>{});},30000);
    return()=>{wsRef.current?.close(1000,"logout");clearInterval(diskIv);};
  },[loggedIn,connectWS,handleApiError]);

  // ─── Logout ───
  const doLogout=useCallback(async()=>{
    await apiFetch("/api/auth/logout",{method:"POST"}).catch(()=>{});
    wsRef.current?.close(1000,"logout");
    setCurUser(null);setLoggedIn(false);setTorrents([]);setUsers([]);
  },[]);

  const uObj=curUser||{perms:{download:true,upload:true,external:true,webhook:true},role:"admin"};

  if(authChecking)return<div style={{minHeight:"100dvh",background:"#080a12",display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-hurricane fa-spin" style={{fontSize:36,color:"#7c3aed"}}/></div>;
  if(!loggedIn)return<Login onLogin={d=>{setCurUser(d);setLoggedIn(true);if(window.innerWidth<=768)setSidebar(false);window.scrollTo(0,0);}} lang={lang} setLang={setLang}/>;

  const canUp=uObj.role==="admin"||uObj.perms?.upload;
  const togSel=id=>setSel(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});
  const togAll=()=>setSel(p=>p.size===filt.length?new Set():new Set(filt.map(x=>x.id)));
  const doAct=async a=>{if(!sel.size)return;const ids=[...sel];const l={pause:t.tPaused,resume:t.tResumed,remove:t.tRemoved};
    if(a==="remove"){const names=ids.map(id=>torrents.find(x=>x.id===id)?.name||id);setDetail(null);
      if(appSettings.confirm_del==="false"){await Promise.allSettled(ids.map(id=>apiFetch(`/api/torrents/${id}?delete_files=false`,{method:"DELETE"})));setTorrents(p=>p.filter(x=>!ids.includes(x.id)));setSel(new Set());addToast(`${ids.length} ${t.tRemoved}`,"info");return;}
      setDeleteConfirm({ids,names});return;}
    await Promise.allSettled(ids.map(id=>{
      if(a==="pause")return apiFetch(`/api/torrents/${id}/pause`,{method:"POST"});
      if(a==="resume")return apiFetch(`/api/torrents/${id}/resume`,{method:"POST"});
    }));
    addToast(`${ids.length} ${l[a]}`,"info");
    setSel(new Set());
  };
  const doDeleteConfirmed=async(deleteFiles)=>{
    const {ids}=deleteConfirm;
    await Promise.allSettled(ids.map(id=>apiFetch(`/api/torrents/${id}?delete_files=${deleteFiles}`,{method:"DELETE"})));
    setTorrents(p=>p.filter(x=>!ids.includes(x.id)));
    setSel(new Set());setDeleteConfirm(null);
    addToast(`${ids.length} ${t.tRemoved}`,"info");
  };
  const doOne=async(id,action)=>{
    if(action==="remove"){const tor=torrents.find(x=>x.id===id);setDetail(null);
      if(appSettings.confirm_del==="false"){await apiFetch(`/api/torrents/${id}?delete_files=false`,{method:"DELETE"});setTorrents(p=>p.filter(x=>x.id!==id));addToast(`1 ${t.tRemoved}`,"info");return;}
      setDeleteConfirm({ids:[id],names:[tor?.name||id]});return;}
    await apiFetch(`/api/torrents/${id}/${action}`,{method:"POST"});
  };

  const filt=torrents.filter(x=>{if(filter!=="all"&&x.status!==filter)return false;if(search&&!x.name.toLowerCase().includes(search.toLowerCase()))return false;return true;});
  const tDown=torrents.filter(x=>x.status==="downloading").reduce((s,x)=>s+(x.downSpeed||0),0);
  const tUp=torrents.filter(x=>x.status!=="queued").reduce((s,x)=>s+(x.upSpeed||0),0);
  const nAct=torrents.filter(x=>x.status==="downloading").length;
  const nDone=torrents.filter(x=>x.status==="completed").length;
  const filters=[{k:"all",l:t.fAll,ic:"fa-layer-group",n:torrents.length},{k:"downloading",l:t.fDown,ic:"fa-arrow-down",n:torrents.filter(x=>x.status==="downloading").length},{k:"completed",l:t.fDone,ic:"fa-circle-check",n:nDone},{k:"paused",l:t.fPause,ic:"fa-pause",n:torrents.filter(x=>x.status==="paused").length},{k:"queued",l:t.fQueue,ic:"fa-clock",n:torrents.filter(x=>x.status==="queued").length}];

  return(
    <LCtx.Provider value={{t,lang,setLang}}>
    <div style={{minHeight:"100dvh",background:C.bg,color:C.text,display:"flex",flexDirection:"column",fontFamily:"'Inter',system-ui,sans-serif"}}>
      {/* HEADER */}
      <header style={{background:"rgba(12,14,24,0.8)",borderBottom:`1px solid rgba(255,255,255,0.05)`,backdropFilter:"blur(20px)",position:"sticky",top:0,zIndex:40}}>
        {isMob&&mobSearch
          ?<div style={{display:"flex",alignItems:"center",gap:8,padding:"0 12px",height:56}}>
              <div style={{position:"relative",flex:1}}><I n="fa-solid fa-magnifying-glass" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:C.muted,fontSize:13}}/><input autoFocus value={search} onChange={e=>setSearch(e.target.value)} placeholder={t.search} style={{...sInp,paddingLeft:38}}/></div>
              <button onClick={()=>{setMobSearch(false);setSearch("");}} style={{...sGhost,padding:8,flexShrink:0}}><I n="fa-solid fa-xmark"/></button>
            </div>
          :<div style={{display:"flex",alignItems:"center",padding:"0 12px",height:56,gap:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                <button onClick={()=>setSidebar(!sidebar)} style={{...sGhost,padding:8}}><I n="fa-solid fa-bars"/></button>
                <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}><div style={{width:28,height:28,borderRadius:10,background:`linear-gradient(135deg,${C.vio},${C.ind})`,display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-hurricane" style={{color:"#fff",fontSize:12}}/></div><span style={{fontSize:17,fontWeight:800,background:"linear-gradient(135deg,#c4b5fd,#93c5fd)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Bittora</span></div>
              </div>
              {!isMob&&<div style={{flex:1,maxWidth:480,margin:"0 16px"}}><div style={{position:"relative"}}><I n="fa-solid fa-magnifying-glass" style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:C.muted,fontSize:13}}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t.search} style={sInpI}/></div></div>}
              <div style={{display:"flex",alignItems:"center",gap:isMob?2:8,marginLeft:"auto"}}>
                {!isMob&&<div style={{display:"flex",alignItems:"center",gap:20,marginRight:16}}><span style={{display:"flex",alignItems:"center",gap:6,fontSize:12}}><I n="fa-solid fa-arrow-down" style={{color:C.em}}/><span style={{color:C.text,fontWeight:500}}>{tDown.toFixed(1)} MB/s</span></span><span style={{display:"flex",alignItems:"center",gap:6,fontSize:12}}><I n="fa-solid fa-arrow-up" style={{color:"#60a5fa"}}/><span style={{color:C.text,fontWeight:500}}>{tUp.toFixed(1)} MB/s</span></span></div>}
                {isMob&&<button onClick={()=>setMobSearch(true)} style={{...sGhost,padding:8}}><I n="fa-solid fa-magnifying-glass"/></button>}
                {canUp&&<button onClick={()=>setShowAdd(true)} style={{...sBtn,padding:isMob?"8px 10px":"8px 16px",fontSize:13,gap:isMob?0:8}}><I n="fa-solid fa-plus"/>{!isMob&&<span> {t.add}</span>}</button>}
                <button onClick={()=>{setShowSetTab("general");setShowSet(true);}} style={{...sGhost,padding:8}}><I n="fa-solid fa-gear"/></button>
                {!isMob&&<div style={{width:1,height:24,background:C.border,margin:"0 4px"}}/>}
                <button onClick={()=>{setShowSetTab("account");setShowSet(true);}} style={{...sGhost,display:"flex",alignItems:"center",gap:4,padding:"0 6px",height:40}}><I n={uObj.role==="admin"?"fa-solid fa-user-shield":"fa-solid fa-user-circle"} style={{fontSize:16}}/>{!isMob&&<span style={{fontSize:12,color:C.dim}}>{curUser?.username}</span>}</button>
                {!isMob&&<div style={{width:1,height:24,background:C.border,margin:"0 4px"}}/>}
                <button onClick={doLogout} title="Odhlásiť" style={{...sGhost,padding:8,color:C.red}}><I n="fa-solid fa-right-from-bracket" style={{fontSize:15}}/></button>
              </div>
            </div>
        }
      </header>

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {sidebar&&<><div onClick={()=>setSidebar(false)} style={{display:isMob?"block":"none",position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(2px)",zIndex:45}}/><aside style={isMob?{position:"fixed",left:0,top:0,bottom:0,width:260,background:"rgba(8,10,18,0.98)",borderRight:`1px solid rgba(255,255,255,0.08)`,padding:12,display:"flex",flexDirection:"column",zIndex:46,overflowY:"auto"}:{width:220,background:"rgba(12,14,24,0.5)",borderRight:`1px solid rgba(255,255,255,0.04)`,padding:12,display:"flex",flexDirection:"column",flexShrink:0,overflowY:"auto"}}>
          <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:2,padding:"0 12px",marginBottom:8}}>{t.filters}</div>
          {filters.map(f=><button key={f.k} onClick={()=>setFilter(f.k)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:12,fontSize:13,border:"none",cursor:"pointer",marginBottom:2,background:filter===f.k?"rgba(139,92,246,0.12)":"transparent",color:filter===f.k?"#a78bfa":C.muted,textAlign:"left"}}><I n={`fa-solid ${f.ic}`} style={{fontSize:11,width:16,textAlign:"center"}}/><span style={{flex:1}}>{f.l}</span><span style={{fontSize:10,padding:"2px 6px",borderRadius:6,background:filter===f.k?"rgba(139,92,246,0.2)":"rgba(255,255,255,0.04)",color:filter===f.k?"#a78bfa":"#6b7280"}}>{f.n}</span></button>)}
          <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:2,padding:"12px 12px 8px"}}>{t.cats}</div>
          {categories.map(c=><button key={c.id||c.name} onClick={()=>{setFilter("all");setSearch(c.name);}} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:12,fontSize:13,border:"none",cursor:"pointer",background:"transparent",color:C.muted,textAlign:"left"}}><div style={{width:8,height:8,borderRadius:"50%",background:c.color,flexShrink:0}}/>{c.name}</button>)}
          <div style={{marginTop:"auto",paddingTop:12,display:"flex",flexDirection:"column",gap:8}}><div style={{...glass,padding:12,borderRadius:12}}><div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:6}}><span style={{color:C.muted}}><I n="fa-solid fa-hard-drive"/> {t.disk}</span><span style={{color:C.dim}}>{disk?`${(disk.free/1073741824).toFixed(0)} GB ${t.free}`:""}</span></div><PBar progress={disk?.percent||0} status="downloading"/></div>{disk?.mounts?.length>0&&disk.mounts.map(m=>{const isSMB=m.fstype==="cifs"||m.source?.startsWith("//");const clr=isSMB?"#22d3ee":"#f59e0b";const ic=isSMB?"fa-solid fa-network-wired":"fa-solid fa-folder-tree";const connMatch=connections.find(c=>(c.type==="smb"||c.type==="nfs")&&m.name===c.name.replace(/[^a-zA-Z0-9]/g,'-').toLowerCase());return<div key={m.path} style={{...glass,padding:12,borderRadius:12}}><div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:6}}><span style={{color:clr,display:"flex",alignItems:"center",gap:4}}><I n={ic}/> {connMatch?connMatch.name:m.name}</span><span style={{color:C.dim}}>{m.free?`${(m.free/1073741824).toFixed(0)} GB ${t.free}`:""}</span></div><PBar progress={m.percent||0} status={m.percent>90?"error":m.percent>70?"paused":"downloading"}/></div>;})}</div>
        </aside></>}

        <main style={{flex:1,overflow:"auto",padding:16,display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"grid",gridTemplateColumns:isMob?"1fr 1fr":"repeat(4,1fr)",gap:12}}>
            <SCrd icon="fa-solid fa-arrow-down" value={`${tDown.toFixed(1)} MB/s`} label={t.dl} color="rgba(16,185,129,0.15)"/>
            <SCrd icon="fa-solid fa-arrow-up" value={`${tUp.toFixed(1)} MB/s`} label={t.ul} color="rgba(59,130,246,0.15)"/>
            <SCrd icon="fa-solid fa-rotate" value={nAct} label={t.active} color="rgba(139,92,246,0.15)"/>
            <SCrd icon="fa-solid fa-circle-check" value={nDone} label={t.done} color="rgba(16,185,129,0.15)"/>
          </div>

          {sel.size>0&&<div style={{...glass,padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}><I n="fa-solid fa-check-double" style={{color:C.vioL}}/><span style={{fontSize:13,color:"#a78bfa",fontWeight:500}}>{sel.size} {t.sel}</span><div style={{display:"flex",gap:8,marginLeft:"auto"}}>{[["pause","fa-pause",t.pause,C.amb],["resume","fa-play",t.resume,C.em],["remove","fa-trash",t.remove,C.red]].map(([a,ic,l,clr])=><button key={a} onClick={()=>doAct(a)} style={{padding:"6px 12px",fontSize:11,borderRadius:8,border:`1px solid ${clr}33`,background:`${clr}1a`,color:clr,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}><I n={`fa-solid ${ic}`}/>{l}</button>)}</div></div>}

          {isMob
            ?<div style={{display:"flex",flexDirection:"column",gap:8}}>
              {filt.map(x=><div key={x.id} onClick={()=>setDetail(x)} style={{...glass,padding:12,borderRadius:12,background:sel.has(x.id)?"rgba(139,92,246,0.08)":"",cursor:"pointer"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <input type="checkbox" checked={sel.has(x.id)} onChange={()=>togSel(x.id)} style={{accentColor:C.vio,flexShrink:0,width:16,height:16}} onClick={e=>e.stopPropagation()}/>
                  <div style={{width:32,height:32,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,background:x.status==="completed"?"rgba(16,185,129,0.1)":x.status==="downloading"?"rgba(139,92,246,0.1)":"rgba(255,255,255,0.04)"}}><I n={`fa-solid ${x.status==="completed"?"fa-circle-check":x.status==="downloading"?"fa-arrow-down":x.status==="paused"?"fa-pause":"fa-clock"}`} style={{color:x.status==="completed"?C.em:x.status==="downloading"?C.vioL:C.muted}}/></div>
                  <div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:500,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.name}</div><div style={{fontSize:10,color:C.muted}}>{x.size}{x.category&&<span> · {x.category}</span>}</div></div>
                  <SBadge status={x.status}/>
                </div>
                <PBar progress={x.progress} status={x.status}/>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:6}}>
                  <span style={{fontSize:10,color:C.muted}}>{x.progress.toFixed(1)}%{x.downSpeed>0&&<span style={{color:C.em}}> · ↓ {x.downSpeed.toFixed(1)} MB/s</span>}</span>
                  <div style={{display:"flex",gap:4}}>
                    {x.status==="paused"
                      ?<button onClick={e=>{e.stopPropagation();doOne(x.id,"resume");}} style={{width:26,height:26,borderRadius:7,border:"none",cursor:"pointer",background:"rgba(16,185,129,0.12)",color:C.em,display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-play" style={{fontSize:10}}/></button>
                      :<button onClick={e=>{e.stopPropagation();doOne(x.id,"pause");}} style={{width:26,height:26,borderRadius:7,border:"none",cursor:"pointer",background:"rgba(245,158,11,0.12)",color:C.amb,display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-pause" style={{fontSize:10}}/></button>}
                    <button onClick={e=>{e.stopPropagation();doOne(x.id,"remove");}} style={{width:26,height:26,borderRadius:7,border:"none",cursor:"pointer",background:"rgba(239,68,68,0.12)",color:C.red,display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-trash" style={{fontSize:10}}/></button>
                  </div>
                </div>
              </div>)}
              {filt.length===0&&<div style={{padding:"60px 0",textAlign:"center"}}><I n="fa-solid fa-inbox" style={{fontSize:40,color:"#1f2937",display:"block",marginBottom:12}}/><p style={{color:C.muted,fontWeight:500,margin:0}}>{t.noTor}</p><p style={{fontSize:13,color:"#4b5563",marginTop:4}}>{t.noTorH}</p></div>}
            </div>
            :<div style={{...glass,overflow:"hidden",borderRadius:16}}>
              <div style={{display:"grid",gridTemplateColumns:"40px 4fr 100px 2fr 80px 60px 60px 60px 88px",gap:8,padding:"12px 16px",background:"rgba(255,255,255,0.02)",borderBottom:`1px solid rgba(255,255,255,0.05)`,fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1,fontWeight:500}}>
                <div><input type="checkbox" onChange={togAll} checked={sel.size===filt.length&&filt.length>0} style={{accentColor:C.vio}}/></div>
                <div>{t.name}</div><div style={{textAlign:"center"}}>{t.status}</div><div>{t.progress}</div><div style={{textAlign:"right"}}>{t.speed}</div><div style={{textAlign:"center"}}>{t.sp}</div><div style={{textAlign:"center"}}>{t.dest}</div><div style={{textAlign:"right"}}>{t.eta}</div><div/>
              </div>
              {filt.map(x=><div key={x.id} style={{display:"grid",gridTemplateColumns:"40px 4fr 100px 2fr 80px 60px 60px 60px 88px",gap:8,padding:"12px 16px",borderBottom:`1px solid rgba(255,255,255,0.03)`,background:sel.has(x.id)?"rgba(139,92,246,0.06)":"transparent",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center"}}><input type="checkbox" checked={sel.has(x.id)} onChange={()=>togSel(x.id)} style={{accentColor:C.vio}}/></div>
                <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0,cursor:"pointer"}} onClick={()=>setDetail(x)}><div style={{width:36,height:36,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,background:x.status==="completed"?"rgba(16,185,129,0.1)":x.status==="downloading"?"rgba(139,92,246,0.1)":"rgba(255,255,255,0.04)"}}><I n={`fa-solid ${x.status==="completed"?"fa-circle-check":x.status==="downloading"?"fa-arrow-down":x.status==="paused"?"fa-pause":"fa-clock"}`} style={{color:x.status==="completed"?C.em:x.status==="downloading"?C.vioL:C.muted}}/></div><div style={{minWidth:0}}><div style={{fontSize:14,fontWeight:500,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.name}</div><div style={{fontSize:11,color:C.muted}}>{x.size}{x.category&&<span> · <I n="fa-solid fa-tag" style={{fontSize:8}}/> {x.category}</span>}</div></div></div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center"}}><SBadge status={x.status}/></div>
                <div style={{display:"flex",flexDirection:"column",justifyContent:"center",gap:6}}><PBar progress={x.progress} status={x.status}/><span style={{fontSize:10,color:C.muted}}>{x.progress.toFixed(1)}%</span></div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",fontSize:12}}>{x.downSpeed>0?<span style={{color:C.em}}>{x.downSpeed.toFixed(1)}&nbsp;<span style={{fontSize:9,color:C.muted}}>MB/s</span></span>:<span style={{color:"#374151"}}>—</span>}</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:C.muted}}>{x.seeds}/{x.peers}</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center"}}><DBadge d={x.destination}/></div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",fontSize:11,color:C.muted}}>{x.eta}</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:4}}>
                  {x.status==="paused"
                    ?<button onClick={()=>doOne(x.id,"resume")} title={t.resume} style={{width:28,height:28,borderRadius:8,border:"none",cursor:"pointer",background:"rgba(16,185,129,0.12)",color:C.em,display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-play" style={{fontSize:11}}/></button>
                    :<button onClick={()=>doOne(x.id,"pause")} title={t.pause} style={{width:28,height:28,borderRadius:8,border:"none",cursor:"pointer",background:"rgba(245,158,11,0.12)",color:C.amb,display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-pause" style={{fontSize:11}}/></button>}
                  <button onClick={()=>doOne(x.id,"remove")} title={t.remove} style={{width:28,height:28,borderRadius:8,border:"none",cursor:"pointer",background:"rgba(239,68,68,0.12)",color:C.red,display:"flex",alignItems:"center",justifyContent:"center"}}><I n="fa-solid fa-trash" style={{fontSize:11}}/></button>
                </div>
              </div>)}
              {filt.length===0&&<div style={{padding:"80px 0",textAlign:"center"}}><I n="fa-solid fa-inbox" style={{fontSize:48,color:"#1f2937",display:"block",marginBottom:16}}/><p style={{color:C.muted,fontWeight:500,margin:0}}>{t.noTor}</p><p style={{fontSize:13,color:"#4b5563",marginTop:4}}>{t.noTorH}</p></div>}
            </div>}

          {detail&&(isMob
            ?<div style={{position:"fixed",inset:0,zIndex:200,display:"flex",flexDirection:"column",justifyContent:"flex-end",animation:"detailFadeIn 0.2s ease"}}>
              <div onClick={()=>setDetail(null)} style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(8px)"}}/>
              <div style={{...glass,position:"relative",borderRadius:"24px 24px 0 0",maxHeight:"88vh",display:"flex",flexDirection:"column",animation:"detailSlideUp 0.32s cubic-bezier(0.32,0.72,0,1)"}}>
                {/* drag handle */}
                <div style={{width:40,height:4,borderRadius:2,background:"rgba(255,255,255,0.15)",margin:"14px auto 0",flexShrink:0}}/>
                {/* header */}
                <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 20px 16px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
                  <div style={{width:46,height:46,borderRadius:15,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,background:"rgba(139,92,246,0.15)",border:`1px solid rgba(139,92,246,0.2)`}}>
                    <I n="fa-solid fa-file-zipper" style={{color:C.vioL,fontSize:20}}/>
                  </div>
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{fontSize:15,fontWeight:600,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{detail.name}</div>
                    <div style={{fontSize:12,color:C.muted,marginTop:2}}>{detail.size} · {detail.added}</div>
                  </div>
                  <button onClick={()=>setDetail(null)} style={{width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.07)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:C.dim}}>
                    <I n="fa-solid fa-xmark" style={{fontSize:13}}/>
                  </button>
                </div>
                {/* scrollable body */}
                <div style={{overflowY:"auto",padding:"16px 20px 28px",display:"flex",flexDirection:"column",gap:14}}>
                  {/* status + progress */}
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <SBadge status={detail.status}/>
                      <span style={{fontSize:22,fontWeight:700,color:"#fff",letterSpacing:-0.5}}>{detail.progress.toFixed(1)}<span style={{fontSize:13,fontWeight:400,color:C.muted}}>%</span></span>
                    </div>
                    <PBar progress={detail.progress} status={detail.status}/>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted}}>
                      <span>{fmtBytes(detail.doneBytes)}</span>
                      <span>{fmtBytes(detail.totalBytes)}</span>
                    </div>
                  </div>
                  {/* stat cards */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[
                      [t.speedD,`${(+detail.downSpeed).toFixed(1)} MB/s`,"fa-arrow-down",C.em],
                      [t.speedU,`${(+detail.upSpeed).toFixed(1)} MB/s`,"fa-arrow-up",C.vioL],
                      [t.ratio,(+detail.ratio).toFixed(2),"fa-scale-balanced",C.amb],
                      [t.sp,`${detail.seeds} / ${detail.peers}`,"fa-users",C.dim],
                      [t.eta,detail.eta,"fa-clock",C.dim],
                      [t.cat,detail.category||"—","fa-tag",C.dim],
                    ].map(([label,value,icon,color],i)=>(
                      <div key={i} style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"12px 14px",border:`1px solid rgba(255,255,255,0.05)`}}>
                        <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}>
                          <I n={`fa-solid ${icon}`} style={{fontSize:10,color}}/>
                          <span style={{fontSize:11,color:C.muted}}>{label}</span>
                        </div>
                        <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {/* destination */}
                  <div style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"12px 14px",border:`1px solid rgba(255,255,255,0.05)`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <I n="fa-solid fa-hard-drive" style={{fontSize:10,color:C.dim}}/>
                      <span style={{fontSize:11,color:C.muted}}>{t.dest}</span>
                    </div>
                    <DBadge d={detail.destination}/>
                  </div>
                  {/* per-torrent speed limits */}
                  <TorLimitPanel detail={detail} addToast={addToast} globalDl={appSettings.max_dl_speed||"0"} globalUl={appSettings.max_ul_speed||"0"}/>
                </div>
              </div>
            </div>
            :<div style={{position:"fixed",inset:0,zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",animation:"detailFadeIn 0.2s ease"}}>
              <div onClick={()=>setDetail(null)} style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(8px)"}}/>
              <div style={{...glass,position:"relative",borderRadius:24,width:480,maxWidth:"92vw",maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column",animation:"detailPopIn 0.24s cubic-bezier(0.34,1.4,0.64,1)"}}>
                {/* header */}
                <div style={{display:"flex",alignItems:"center",gap:14,padding:"20px 24px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
                  <div style={{width:48,height:48,borderRadius:15,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,background:"rgba(139,92,246,0.15)",border:`1px solid rgba(139,92,246,0.2)`}}>
                    <I n="fa-solid fa-file-zipper" style={{color:C.vioL,fontSize:22}}/>
                  </div>
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{fontSize:15,fontWeight:600,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{detail.name}</div>
                    <div style={{fontSize:12,color:C.muted,marginTop:3}}>{detail.size} · {detail.added}</div>
                  </div>
                  <button onClick={()=>setDetail(null)} style={{width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.07)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:C.dim}}>
                    <I n="fa-solid fa-xmark" style={{fontSize:13}}/>
                  </button>
                </div>
                {/* body */}
                <div style={{overflowY:"auto",padding:"20px 24px 24px",display:"flex",flexDirection:"column",gap:16}}>
                  {/* status + progress */}
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <SBadge status={detail.status}/>
                      <span style={{fontSize:24,fontWeight:700,color:"#fff",letterSpacing:-0.5}}>{detail.progress.toFixed(1)}<span style={{fontSize:13,fontWeight:400,color:C.muted}}>%</span></span>
                    </div>
                    <PBar progress={detail.progress} status={detail.status}/>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted}}>
                      <span>{fmtBytes(detail.doneBytes)}</span>
                      <span>{fmtBytes(detail.totalBytes)}</span>
                    </div>
                  </div>
                  {/* stat cards — 3 columns on desktop */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                    {[
                      [t.speedD,`${(+detail.downSpeed).toFixed(1)} MB/s`,"fa-arrow-down",C.em],
                      [t.speedU,`${(+detail.upSpeed).toFixed(1)} MB/s`,"fa-arrow-up",C.vioL],
                      [t.ratio,(+detail.ratio).toFixed(2),"fa-scale-balanced",C.amb],
                      [t.sp,`${detail.seeds} / ${detail.peers}`,"fa-users",C.dim],
                      [t.eta,detail.eta,"fa-clock",C.dim],
                      [t.cat,detail.category||"—","fa-tag",C.dim],
                    ].map(([label,value,icon,color],i)=>(
                      <div key={i} style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"12px 14px",border:`1px solid rgba(255,255,255,0.05)`}}>
                        <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}>
                          <I n={`fa-solid ${icon}`} style={{fontSize:10,color}}/>
                          <span style={{fontSize:11,color:C.muted}}>{label}</span>
                        </div>
                        <div style={{fontSize:14,fontWeight:600,color:"#fff"}}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {/* destination */}
                  <div style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"12px 16px",border:`1px solid rgba(255,255,255,0.05)`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <I n="fa-solid fa-hard-drive" style={{fontSize:11,color:C.dim}}/>
                      <span style={{fontSize:12,color:C.muted}}>{t.dest}</span>
                    </div>
                    <DBadge d={detail.destination}/>
                  </div>
                  {/* per-torrent speed limits */}
                  <TorLimitPanel detail={detail} addToast={addToast} globalDl={appSettings.max_dl_speed||"0"} globalUl={appSettings.max_ul_speed||"0"}/>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <div style={{position:"fixed",top:72,zIndex:300,display:"flex",flexDirection:"column",gap:8,...(isMob?{left:16,right:16,alignItems:"stretch"}:{right:16,alignItems:"flex-end"})}}>{toasts.map(x=><Toast key={x.id} message={x.message} type={x.type} onClose={()=>rmToast(x.id)} mob={isMob}/>)}</div>
      {showSet&&<Settings onClose={()=>setShowSet(false)} addToast={addToast} users={users} setUsers={setUsers} currentUser={curUser} onLogout={doLogout} lang={lang} setLang={setLang} categories={categories} setCategories={setCategories} connections={connections} setConnections={setConnections} openToTab={showSetTab} onSettingsChange={s=>setAppSettings(s||{})} refreshDisk={()=>apiFetch("/api/disk").then(setDisk).catch(()=>{})}/>}
      {showAdd&&<AddTorrentModal isOpen onClose={()=>setShowAdd(false)} onAdd={count=>{addToast(`${count} ${t.tAdded}`,"success");}} addToast={addToast} categories={categories} connections={connections} defaultStorage={appSettings.default_storage||"local"} disk={disk}/>}
      {deleteConfirm&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:16}} onClick={()=>setDeleteConfirm(null)}>
        <div style={{...glass,width:"100%",maxWidth:420,borderRadius:20,padding:24}} onClick={e=>e.stopPropagation()}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{width:44,height:44,borderRadius:14,background:"rgba(239,68,68,0.15)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><I n="fa-solid fa-trash" style={{color:C.red,fontSize:18}}/></div>
            <div><div style={{fontSize:16,fontWeight:600,color:"#fff"}}>{t.delTitle}</div><div style={{fontSize:12,color:C.muted,marginTop:2}}>{deleteConfirm.names.length===1?deleteConfirm.names[0]:`${deleteConfirm.names.length} ${t.torrentsCnt}`}</div></div>
          </div>
          <div style={{background:"rgba(255,255,255,0.04)",borderRadius:12,padding:12,marginBottom:16}}>
            <DeleteFilesOption onSelect={doDeleteConfirmed}/>
          </div>
          <button onClick={()=>setDeleteConfirm(null)} style={{...sGhost,width:"100%",textAlign:"center",border:`1px solid ${C.border}`,borderRadius:12}}>{t.cancel}</button>
        </div>
      </div>}
    </div>
    </LCtx.Provider>
  );
}