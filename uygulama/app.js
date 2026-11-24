"use strict";

const sourceReport = "../ornekler/agentic-os-3.0.0/AGENTIC-OS-3.0.0-INCELEME.md";
const sourceRoot = "../ornekler/agentic-os-3.0.0/calisma/urun/";
const productPath = "agentic";
const sourcePath = "kaynak";
const sections = [
  ["buyuk-resim", "Büyük resim"],
  ["mimari", "Mimari ve kurulum"],
  ["akis", "İşin akışı"],
  ["deneme", "Deneme"]
];
const sourceSections = [
  ["buyuk-resim", "Büyük resim"],
  ["mimari", "Dosyalar ve komutlar"],
  ["akis", "Kaynakta görülenler"],
  ["deneme", "Deneme"]
];
const overviewLabels = ["Ne işe yarar?", "Ne yapar?", "Ne üretir?", "Sonucu nerede kullanılır?"];
const groups = [
  { title: "Sizin kullandığınız", ids: ["ilk-kurulum", "izin-verme", "sohbet-gecmisi", "belge-yonetimi", "bellek", "harcama", "ekranlar"] },
  { title: "Yapay zekânın yaptığı", ids: ["sohbet", "hermes", "jarvis", "dream", "ses"] },
  { title: "Arka planda çalışan", ids: ["siteyi-ac", "kayitlari-topla", "model-listesi"] }
];

const modules = {
  "ilk-kurulum": {
    title: "İlk kurulum", section: "A02",
    summary: "Hangi yerel araçların hazır olduğunu görür ve panel tercihlerinizi seçersiniz.",
    purpose: "Paneli ilk kullanıma hazırlamak.",
    output: "Bulunan araçlar ve seçilen başlangıç tercihleri.",
    use: "Kontrol panelindeki kurulum ekranı ve panel ayarları.",
    trigger: "Ürünün ayrı kurulum komutu çalıştırılır.",
    process: "Araç ve çalışma kayıtları taranır. Panel ilk açılış işaretini görür ve kurulum ekranını açar.",
    decision: "Kurulum ekranı algılanan araçlara göre başlangıç seçimlerini belirler. Kullanıcı bu seçimleri değiştirebilir.",
    proof: "scripts/setup.ts ve src/routes/setup.tsx"
  },
  "izin-verme": {
    title: "İzin verme", section: "A05",
    summary: "Sohbet bir araç için izin veya yanıt istediğinde kararınızı iletirsiniz.",
    purpose: "Bekleyen araç çağrısının kullanıcının kararıyla ilerlemesi.",
    output: "İzin, ret veya kullanıcının yazdığı yanıt.",
    use: "Bekleyen araç çağrısı ve sohbetin durum kartı.",
    trigger: "Claude, sohbet turunda onay gereken bir araç veya kullanıcıya soru gönderir.",
    process: "Sunucu çağrıyı canlı sohbetle eşler ve tarayıcıya bir karar kartı yollar.",
    decision: "Sunucu kart kimliğinin, kart türünün ve bekleyen çağrının eşleşmesini denetler.",
    proof: "vite.config.ts içindeki V11–V13 izin ve soru işleyicileri"
  },
  "sohbet-gecmisi": {
    title: "Sohbet geçmişi ve ekler", section: "A06",
    summary: "Önceki sohbetleri, süren turları ve sohbetteki dosyaları açarsınız.",
    purpose: "Konuşmaya ve ilgili dosyalara yeniden erişmek.",
    output: "Sohbet geçmişi, ek bağlantısı veya yeniden bağlanan canlı yanıt.",
    use: "Sohbet ekranı ve turun dosya bağlantıları.",
    trigger: "Bir geçmiş sohbet, ek bağlantısı veya kopan bağlantı açılır.",
    process: "Panel oturum kimliğine göre arşive ya da devam eden turun olay akışına gider.",
    proof: "vite.config.ts içindeki V14–V20, V24, V53 ve V54 kayıtları"
  },
  "belge-yonetimi": {
    title: "Belge yönetimi", section: "A09",
    summary: "Hermes belge galerisinde dosyaları listeler ve önizlersiniz.",
    purpose: "Hermes’in yerel belgelerine tek bir galeriden erişmek.",
    output: "Belge listesi, önizleme veya seçilen dosya işleminin sonucu.",
    use: "Hermes’in belge galerisi ve yerel Documents dizini.",
    trigger: "Galeri açılır veya kullanıcı bir belge işlemi seçer.",
    process: "Galeri yerel sunucudan listeyi ya da seçilen işleme ait sonucu alır.",
    decision: "Geri yükleme sırasında hedef ad doluysa işleyici ekli bir dosya adı dener.",
    proof: "src/components/hermes-documents-gallery.tsx ve V55 belge işleyicisi"
  },
  "bellek": {
    title: "Bellek ve kod grafiği", section: "A11",
    summary: "Proje içindeki kod bağlantılarını ve kayıtlı notları görürsünüz.",
    purpose: "Kod parçalarının ilişkilerini ve bellek notlarını bulmak.",
    output: "Grafik dosyası, proje listesi veya bellek notları.",
    use: "Kod Grafiği ve Hafıza ekranları.",
    trigger: "Bir proje seçilir, yeni kaynak yolu girilir veya bellek ekranı açılır.",
    process: "Yerel grafik işleyicisi kaynak için Graphify’ı çağırabilir. Ayrı bellek işleyicisi kasadan not okur.",
    proof: "src/routes/codegraph.tsx, src/routes/memory.tsx ve V03–V06, V51"
  },
  "harcama": {
    title: "Harcama ve kullanım göstergeleri", section: "A14",
    summary: "Kullanım, süre ve erişilebilen hesap bilgilerini panelde görürsünüz.",
    purpose: "Kullanım ve maliyet göstergelerini takip etmek.",
    output: "Kullanım ölçüleri, bütçe bilgileri ve paylaşım özeti.",
    use: "Kontrol Paneli, Ayarlar ve Paylaşım ekranları.",
    trigger: "Kullanım paneli açılır veya bütçe bilgisi istenir.",
    process: "Panel, varsa yerel ölçüleri ve ilgili sağlayıcıdan erişilebilen limitleri gösterir.",
    decision: "Örneğin hesap kredisi ile anahtar limiti birlikte geldiğinde bütçe işleyicisi kullanılabilir sınırı esas alır.",
    proof: "src/routes/dashboard.tsx, src/routes/settings.tsx ve V25–V26"
  },
  "ekranlar": {
    title: "Ekranlar ve menüler", section: "A15",
    summary: "Panelin ortak menüsü ve bileşenleriyle farklı ekranlara geçersiniz.",
    purpose: "Panelde gezinmek ve ortak arayüz öğelerini kullanmak.",
    output: "Seçili ekran, menü ve arayüz bileşenlerinin durumu.",
    use: "Tarayıcıdaki uygulama kabuğu ve ürün sayfaları.",
    trigger: "Bir menü öğesi açılır veya ortak bir arayüz bileşeni kullanılır.",
    process: "Uygulama seçili rotayı ve o ekrana ait bileşenleri oluşturur.",
    proof: "src/routes/__root.tsx, src/router.tsx ve src/components/ui/"
  },
  "sohbet": {
    title: "Sohbet", section: "A04",
    summary: "Mesajınız seçilen motora gider, yanıt geldikçe sohbet ekranına yazılır.",
    purpose: "Yerel veya bağlı bir modelle konuşmak.",
    output: "Yanıt, canlı çalışma durumu ve varsa izin isteği.",
    use: "Ana sohbet ekranı ve ilgili oturum.",
    trigger: "Sohbette Gönder’e basılır.",
    process: "Panel mesajı, modeli ve sağlayıcıyı ilgili işleyiciye gönderir. Yerel süreçten gelen olaylar tarayıcıya aktarılır.",
    decision: "Model yolu belirlenirken sağlayıcı kimliği model adına göre yapılan tahminden önce gelir.",
    proof: "src/components/home-command.tsx, src/lib/model-lane.ts ve V10/V21"
  },
  "hermes": {
    title: "Hermes", section: "A08",
    summary: "Panel, Hermes’in modelini, profillerini ve kullanılabilir becerilerini gösterir.",
    purpose: "Hermes’in yerel çalışma ortamını incelemek.",
    output: "Model, profil, beceri ve bağlantı bilgileri.",
    use: "Hermes ekranı ve ilgili çalışma tercihleri.",
    trigger: "Hermes ekranı açılır veya bir çalışma profili seçilir.",
    process: "Panel ilgili yerel yapılandırmayı ve kullanılabilir Hermes bilgilerini okur.",
    proof: "src/routes/agents.hermes.tsx ve V07, V36–V38, V52"
  },
  "jarvis": {
    title: "Jarvis", section: "A07",
    summary: "Bir hedef ve çalışma alanı seçilince işi bir yerel sürece iletir.",
    purpose: "Belirli bir hedef için çalışma alanında görev yürütmek.",
    output: "Çalışma durumu, günlük akışı ve çalışma geçmişi.",
    use: "Jarvis ekranı ve seçilen çalışma alanı.",
    trigger: "Hedef ve çalışma alanıyla başlatma isteği gönderilir.",
    process: "Yerel işleyici profil koşullarını denetler, süreci açar ve günlüğü ekrana aktarır.",
    proof: "src/routes/agents.jarvis.tsx ve V28–V30"
  },
  "dream": {
    title: "Dream", section: "A10",
    summary: "Seçilen motor çalışma bağlamından öneriler üretir.",
    purpose: "Geçmiş çalışmalardan izlenebilir öneriler çıkarmak.",
    output: "Tarihli öneri dosyası ve önerilerin kabul veya ret durumu.",
    use: "Kontrol panelinin Dream alanı ve sonraki panel verisi.",
    trigger: "Dream elle ya da yapılandırılmış zamanlama üzerinden çalıştırılır.",
    process: "Seçilen motor çağrılır. Sonuç yazılır ve panel verisinin yenilenmesi istenir.",
    decision: "Motor seçimi çalıştırma yolunu belirler. Öneri kararı ayrı durum dosyasına yazılır.",
    proof: "vite.config.ts içindeki V59–V62 ve Dream çalıştırma betikleri"
  },
  "ses": {
    title: "Ses", section: "A12",
    summary: "Sesli oturumu başlatır ve mikrofonu bağlamak için tarayıcıyı kullanır.",
    purpose: "Desteklenen sağlayıcı üzerinden sesli etkileşim kurmak.",
    output: "Ses oturumu, ses yanıtı veya sağlayıcı durumu.",
    use: "Ses arayüzü ve tarayıcıdaki canlı görüşme.",
    trigger: "Kullanıcı canlı ses özelliğini açar.",
    process: "Ayrı ses hizmeti bir oturum açar. Başarılı yanıtta tarayıcı mikrofon ve bağlantı adımlarına geçer.",
    proof: "voice-lab/server.ts ve src/components/intelligence-portal.tsx"
  },
  "siteyi-ac": {
    title: "Siteyi aç", section: "A01",
    summary: "Yerel sunucuyu başlatır ve tarayıcıda paneli açar.",
    purpose: "Agentic OS ekranlarını bilgisayarınızda sunmak.",
    output: "Yerel tarayıcı adresi ve seçili uygulama sayfası.",
    use: "Ana sohbet ve panelin diğer sayfaları.",
    trigger: "Geliştirme başlatma komutu çağrılır.",
    process: "Örnek veri hazırlanır, Vite yerel bağlantıyı açar ve rota doğru ekranı seçer.",
    proof: "package.json, vite.config.ts ve src/router.tsx"
  },
  "kayitlari-topla": {
    title: "Çalışma kayıtlarını topla", section: "A03",
    summary: "Yerel çalışma izlerini panelin okuyabileceği bir dosyada birleştirir.",
    purpose: "Paneli etkinlik ve çalışma alanı verisiyle beslemek.",
    output: "Canlı panel verisi veya erişilebildiğinde paket örneği.",
    use: "Etkinlik, Çalışma Alanları ve Kontrol Paneli.",
    trigger: "Toplama betiği çağrılır veya panelde yenileme istenir.",
    process: "Yerel kayıtlar okunur ve tarayıcının kullanacağı veri dosyası hazırlanır.",
    decision: "Canlı veriye ulaşılamadığında panel işleyicisi paket örneğine dönebilir.",
    proof: "scripts/aggregate.ts, src/routes/activity.tsx ve V02/V58"
  },
  "model-listesi": {
    title: "Model listesini ve önerileri hazırla", section: "A13",
    summary: "Model kataloğunu yeniler, uygun görev planlarını hesaplar.",
    purpose: "Görev veya rol için kullanılabilir modelleri göstermek.",
    output: "Katalog, uygun modeller ve hesaplanan planlar.",
    use: "Model seçimi ve Kontrol Panelindeki planlar.",
    trigger: "Model kataloğu yenilenir veya uygun model listesi değişir.",
    process: "Katalog işlenir ve panel, her görev planı için uygun modelleri değerlendirir.",
    decision: "Bir role uyan model yoksa ilgili planın yedek seçimi veya boş sonuç dalı devreye girer.",
    proof: "src/lib/model-intel.ts ve P11/S08 katalog yenileme girişi"
  }
};

const productOverview = [
  "Yapay zekâ araçlarıyla çalışmayı tek bir yerel panelde toplar.",
  "Sohbeti yönlendirir, dosya ve görevleri gösterir, yerel kayıtları toplar.",
  "Sohbet yanıtları, çalışma kayıtları, öneriler ve kullanım özetleri.",
  "Sohbet, Etkinlik, Kontrol Paneli ve ilgili araç ekranlarında."
];

const demos = [
  { title: "Araçları bul", kind: "Kayıtlı veriyle akış", summary: "Hermes’e ait örnek kayıt, ilk kurulum ekranında nasıl görünür?", path: "agentic/mimari/araclari-bul/tetik", action: "Kurulum akışını izle" },
  { title: "Modelin plan etiketi", kind: "Gerçek kodla yerel deneme", summary: "Aynı modelin sağlayıcısını değiştirin ve sohbet ekranı için hangi etiketin üretildiğini görün.", path: "agentic/deneme/model-etiketi", action: "Etiketi dene" }
];

const $ = (id) => document.getElementById(id);
const sourceRecords = new Map();
let requestNumber = 0;
let sourceRequest;
let repoRunRequest;
let lastPath = null;

function node(tag, content, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (typeof content === "string") element.textContent = content;
  else if (content) element.append(...content);
  return element;
}

function link(text, path, className) {
  const element = node("a", text, className);
  element.href = path;
  return element;
}

function heading(text, level = 2) {
  return node("h" + level, text);
}

function details(text, children) {
  return node("details", [node("summary", text), node("div", children, "details-body")]);
}

function overview(values) {
  return node("dl", values.map((value, i) =>
    node("div", [node("dt", overviewLabels[i]), node("dd", value)])), "overview");
}

function list(items) {
  return node("ul", items.map((item) => node("li", item)), "inline-list");
}

function flow(items) {
  return node("ol", items.map(([name, value]) =>
    node("li", [node("strong", name), node("p", value)])), "flow-list");
}

function back(text, path) {
  return link("← " + text, "#" + path, "back-link");
}

function paragraph(text) {
  return node("p", text, "lead");
}

function panel(title, children) {
  return node("section", [heading(title, 3), ...children], "panel");
}

function trialResult({ input, output, purpose, usage }) {
  const rows = [
    ["Ne verdim?", node("pre", input, "trial-input")],
    ["Ne çıktı?", output],
    ["Bu çıktı ne işe yarıyor?", purpose],
    ["Nerede kullanılıyor?", usage]
  ];
  return node("section", [
    heading("Deneme sonucu", 4),
    node("dl", rows.map(([label, content]) => node("div", [
      node("dt", label),
      node("dd", typeof content === "string" ? content : Array.isArray(content) ? content : [content])
    ])), "trial-facts")
  ], "trial-result");
}

function focusHeading(element) {
  element.tabIndex = -1;
  element.focus({ preventScroll: true });
}

function moduleCard(id, section) {
  const record = modules[id];
  const element = link("", "#" + productPath + "/" + section + "/is/" + id, "work-card");
  const arrow = node("span", "→", "card-arrow");
  arrow.setAttribute("aria-hidden", "true");
  element.append(node("strong", record.title), arrow, node("p", record.summary));
  return element;
}

function groupsView(section) {
  return groups.map((group) => node("section", [
    node("div", [heading(group.title, 3), node("span", group.ids.length + " işlev", "count")], "group-title"),
    node("div", group.ids.map((id) => moduleCard(id, section)), "card-list")
  ], "group"));
}

function productHome() {
  return [
    heading("Büyük resim"),
    overview(productOverview),
    ...groupsView("buyuk-resim")
  ];
}

function productArchitecture() {
  return [
    heading("Mimari ve kurulum"),
    paragraph("Agentic OS tarayıcıdaki paneli yerel bir sunucuyla açar. Sohbet motorları, ses hizmeti ve çalışma araçları kendi süreçlerinde çalışabilir."),
    node("div", [
      panel("Paneli açma", [
        paragraph("Ürün klasöründe Bun kullanılır. Geliştirme komutu örnek veriyi hazırlar ve yerel paneli açar."),
        link("Siteyi aç işlevini incele →", "#agentic/mimari/is/siteyi-ac", "button secondary")
      ]),
      panel("İlk kurulum", [
        paragraph("Ayrı kurulum komutu yerel araçları denetler. Panel, bulunan araçları gösterir ve başlangıç tercihlerini alır."),
        link("İlk kurulumu incele →", "#agentic/mimari/is/ilk-kurulum", "button secondary")
      ])
    ], "tool-grid"),
    node("div", [
      details("Çalıştırma yolları ve yerel etkiler", [
        list([
          "Geliştirme: bun run dev, örnek veriyi hazırlar ve Vite üzerinden 127.0.0.1:8081 adresini açar.",
          "İlk kurulum: bun run setup, araçları taramanın yanında aşağıdaki dosya ve ayar değişikliklerini yapabilir. Burada çalıştırılmadı.",
          "Voice, ayrı Bun sürecinde varsayılan 8099 portuyla çalışır. Önizleme, derlenmiş sayfaları sunar."
        ]),
        link("Windows inceleme raporunu aç", sourceReport, "text-link")
      ]),
      setupEffects()
    ], "details-stack")
  ];
}

function productFlow() {
  return [
    heading("İşin akışı"),
    paragraph("Bir işlevi açıp ne zaman devreye girdiğini, ne yaptığını ve sonucunun nereye gittiğini izleyin."),
    ...groupsView("akis")
  ];
}

function productDemos() {
  return [
    heading("Deneme"),
    paragraph("İlk örnek, kayıtlı bir kurulum çıktısını izletir. İkinci örnek, ürünün etiket hesaplayan kodunu burada çalıştırır."),
    node("div", demos.map((demo) => node("section", [
      node("p", demo.kind, "label"),
      heading(demo.title, 3),
      paragraph(demo.summary),
      link(demo.action + " →", "#" + demo.path, "button secondary")
    ], "panel")), "tool-grid")
  ];
}

function moduleView(id, section) {
  const item = modules[id];
  const group = groups.find((entry) => entry.ids.includes(id));
  const previous = section === "mimari" ? "Mimari ve kuruluma dön" :
    section === "akis" ? "İşin akışına dön" : "İş kartlarına dön";
  const panels = [
    details("İşin akışı", [flow([
      ["Ne zaman başlar?", item.trigger],
      ["Ne alır ve ne yapar?", item.process],
      ["Ne üretir?", item.output],
      ["Sonucu nerede kullanılır?", item.use]
    ])])
  ];
  if (section === "akis") panels[0].open = true;
  if (item.decision) panels.push(details("Karar mantığı", [paragraph(item.decision)]));
  if (id === "ilk-kurulum") panels.push(setupEffects());
  panels.push(details("Kaynak ve kanıt", [
    node("p", "İnceleme raporundaki bölüm: " + item.section + "."),
    node("p", item.proof),
    link("Agentic OS inceleme raporunu aç", sourceReport, "text-link")
  ]));
  const children = [
    back(previous, productPath + "/" + section),
    node("header", [node("p", group.title, "module-group"), heading(item.title), paragraph(item.summary)], "module-head"),
    overview([item.purpose, item.summary, item.output, item.use])
  ];
  if (["ilk-kurulum", "hermes", "sohbet", "model-listesi"].includes(id)) {
    const recorded = id === "ilk-kurulum" || id === "hermes";
    const demo = demos[recorded ? 0 : 1];
    children.push(node("div", [panel(demo.title, [
      node("p", recorded ? "Kayıt örneği · bilgisayarınızda araç taranmadı" : "Gerçek yerel karar · yalnız etiket hesabı", "label"),
      paragraph(demo.summary),
      ...(!recorded ? [node("p", "Bu örnek model kataloğunu yenilemez ve uygun model planlarını sınamaz. Kaynaktan alınan etiket kararını bu pencerede hesaplar.")] : []),
      link((recorded ? "Araçları bul" : demo.action) + " →", "#" + demo.path, "button primary")
    ])], "detail-shell"));
  }
  if (id === "dream" || id === "ses") children.push(moduleEvidence(id));
  children.push(node("div", panels, "details-stack"));
  return children;
}

function setupEffects() {
  return details("Kurulum bilgisayarımda neyi değiştirir?", [
    paragraph("Güncel kopyanın kaynak davranışı. Ürün Tanı bu kurulumu çalıştırmadı; bilgisayarınızda bu değişikliklerin varlığı kontrol edilmedi."),
    flow([
      ["Beceri dosyaları", "Dream, CLAUDE_CONFIG_DIR/skills/dream dizinine (değişken yoksa ~/.claude/skills/dream); personas, seçilen HERMES_HOME altındaki skills/personas dizinine kopyalanır. Personas kopyası mevcut beceriyi güncelleyebilir. Kaynak: setup.ts:116–164."],
      ["Git kancası", "Aynı Git deposu doğrulanır, kanca dosyası bulunur ve mevcut hooksPath ayarı yoksa yalnız bu depoda core.hooksPath=.githooks yazılır. Var olan farklı ayar korunur. Kaynak: setup.ts:167–210."],
      ["Zamanlama", "Güncel setup.ts:212–239, Windows’ta Görev Zamanlayıcı, macOS’ta launchd kurucusunu çağırır. Windows görev adı ClaudeOS Dream’dir. Linux’ta otomatik kurmaz. Kaynakta bu dalın bulunması zamanlanmış Dream’in bu bilgisayarda başarıyla çalıştığını göstermez."],
      ["İlk açılış işareti", "~/.claude-os/show-wizard dosyasına tarih yazılır; sonraki geliştirme açılışında kurulum sihirbazını göstermek içindir. Kaynak: setup.ts:377–386."]
    ]),
    node("p", "Windows raporundaki eski sürüm veya yalıtılmış deney sonuçları kendi kaynakları ve girdileriyle sınırlıdır. Güncel kopyada Windows zamanlayıcı dalı var; gerçek profil, model ve zamanlanmış Dream kabulü raporda açık kalıyor."),
    link("Güncel kurulum kaynağını aç", sourceRoot + "scripts/setup.ts", "text-link"),
    link("Windows raporunun kapsamını aç", sourceReport, "text-link")
  ]);
}

function moduleEvidence(id) {
  const dream = id === "dream";
  return node("div", [panel("Bilgisayarımda çalıştı mı?", [
    paragraph(dream
      ? "Bu incelemede Dream başlatılmadı. Kaynak, motor çağrısını, öneri dosyasını ve panel yenilemesini gösteriyor."
      : "Bu incelemede mikrofon veya ses hizmeti açılmadı. Kaynak, oturum açma ve tarayıcı bağlantısının nasıl istendiğini gösteriyor."),
    node("p", dream
      ? "Önceki Windows raporunda sentetik motorlarla başarı, başlatma hatası ve zaman aşımı yolları ölçülmüş. Gerçek model/profil ve Görev Zamanlayıcı ile sonuç üretimi doğrulanmış değil."
      : "Önceki Windows deneylerinde yerel Bun/HTTP yolları ve sentetik sağlayıcı yanıtları ölçülmüş. Gerçek mikrofon, WebRTC, sağlayıcı ve duyulan Türkçe ses kalitesi doğrulanmış değil."),
    link(dream ? "Dream Windows kanıtını aç" : "Ses Windows kanıtını aç", "../ornekler/agentic-os-3.0.0/calisma/notlar/" + (dream ? "windows-surec.md" : "windows-voice-tr.md"), "text-link")
  ])], "detail-shell");
}
 
const toolSteps = [
  ["tetik", "Başlangıç"],
  ["cikti", "Örnek çıktı"],
  ["kurulum", "Kurulumda görünümü"]
];

function toolsView(step) {
  const base = "agentic/mimari/araclari-bul/";
  const progress = node("ol", toolSteps.map(([id, title]) => {
    const entry = link(title, "#" + base + id);
    if (id === step) entry.setAttribute("aria-current", "step");
    return node("li", [entry]);
  }), "stepper");
  const sample = globalThis.hermesExample;
  const present = typeof sample?.detected === "boolean";
  const parts = [];
  if (step === "tetik") {
    parts.push(panel("Ne zaman başlar?", [
      paragraph("Gerçek üründe kurulum komutu, makinedeki araçları arayan veri toplayıcıyı çağırır. Toplayıcı sonucu bir dosyaya yazar."),
      link("Örnek çıktıyı gör →", "#" + base + "cikti", "button primary")
    ]));
  } else if (step === "cikti") {
    parts.push(panel("Toplayıcının Hermes kaydı", [
      paragraph("Bu alan Agentic OS ile gelen örnek veri dosyasından alınır."),
      node("pre", present ? JSON.stringify(sample, null, 2) : "Hermes örnek verisi yüklenemedi."),
      link("Kurulumda nasıl göründüğüne bak →", "#" + base + "kurulum", "button primary")
    ]));
  } else {
    const status = present ? (sample.detected ? "Algılandı" : "Bulunamadı") : "Örnek veri yüklenemedi";
    const selection = present ? (sample.detected ? "Açık" : "Kapalı") : "Bilinmiyor";
    parts.push(panel("Kurulum ekranındaki Hermes satırı", [
      paragraph("Kurulum ekranı Hermes’in bulunma bilgisini okur ve başlangıç seçimini buna göre ayarlar."),
      node("div", [
        node("strong", "Hermes Agent"),
        node("dl", [
          node("dt", "Durum"), node("dd", status),
          node("dt", "Başlangıç seçimi"), node("dd", selection)
        ])
      ], "readout"),
      paragraph("Paket örneğinde hiçbir araç bulunmadığı için ürünün gerçek kurulum ekranı boş durumu gösterir. Hermes satırı burada tek başına gösteriliyor."),
      link("Baştan izle", "#" + base + "tetik", "button secondary")
    ]));
  }
  return [
    back("İlk kuruluma dön", "agentic/mimari/is/ilk-kurulum"),
    heading("Araçları bul"),
    paragraph("Kayıtlı veriyle akış. Yerel araç taraması başlatılmadan örnek kaydın kurulum ekranına nasıl ulaştığını görün."),
    progress,
    ...parts,
    node("div", [
      details("Kaynak ve kanıt", [
        list([
          "scripts/setup.ts:273–280, veri toplayıcıyı çağırır.",
          "scripts/aggregate.ts:2503–2511, 3346–3361, 4074 ve 4089, araç verisini toplayıp dosyaya yazar.",
          "src/routes/setup.tsx:138–146, 263–289, 417–439 ve 1325–1346, değeri kurulum ekranında kullanır."
        ]),
        link("Örnek veri dosyasını aç", sourceRoot + "src/data/live-data.example.json", "text-link")
      ])
    ], "details-stack")
  ];
}

function modelView() {
  const options = ["openai-codex", "openai"].map((provider) => {
    const option = node("option", provider);
    option.value = provider;
    return option;
  });
  const label = node("label", "Sağlayıcı");
  label.htmlFor = "model-provider";
  const select = node("select", options);
  select.id = label.htmlFor;
  const submit = node("button", "Etiketi hesapla", "button primary");
  submit.type = "submit";
  const form = node("form", [node("div", [label, select]), submit], "model-form");
  const status = node("p", "", "field-note");
  status.setAttribute("role", "status");
  const result = node("div");
  result.id = "model-result";
  select.addEventListener("change", () => {
    result.replaceChildren();
    status.textContent = "";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = globalThis.agenticLane;
    result.replaceChildren();
    if (typeof code?.laneFor !== "function" || typeof code?.payerLabel !== "function") {
      status.textContent = "Agentic OS model kodu yüklenemedi.";
      return;
    }
    const model = "gpt-5.6-sol";
    const provider = select.value;
    const lane = code.laneFor(model, provider);
    result.append(
      trialResult({
        input: "Model " + model + "\nSağlayıcı " + provider,
        output: node("p", code.payerLabel(lane, provider), "trial-value"),
        purpose: "Seçili model için hangi planın ya da hesabın kullanılacağını belirtir.",
        usage: "Agentic OS, sohbet ekranındaki Kullanım panelinde bu etiketi Faturalandırma satırında gösterir."
      }),
      details("Hesabın ayrıntısı", [node("p", "Kodun seçtiği çalışma yolu " + lane)])
    );
    status.textContent = "Etiket hesaplandı.";
  });
  return [
    back("Denemelere dön", "agentic/deneme"),
    heading("Modelin plan etiketi"),
    paragraph("Agentic OS, seçili model ve sağlayıcıdan sohbet ekranında göstereceği ödeme etiketini hesaplar."),
    node("div", [panel("Sağlayıcıyı değiştirin", [
      paragraph("Model adı gpt-5.6-sol. Hesaplama ürün kodunu tarayıcıda çalıştırır ve model isteği göndermez."),
      form,
      status,
      result
    ])], "detail-shell"),
    node("div", [
      details("Karar mantığı", [
        paragraph("laneFor önce sağlayıcı kimliğini değerlendirir. Sağlayıcıdan yol çıkmazsa model adına bakar. payerLabel, hesaplanan yol ve sağlayıcıdan kullanıcıya gösterilecek metni üretir.")
      ]),
      details("Kaynak ve kanıt", [
        node("p", "Üretilen etiket sohbet ekranında kullanılır. Canlı hesap, fatura veya harcama bu hesaplamanın girdisi değildir."),
        link("Model kararının kaynak kodunu aç", sourceRoot + "src/lib/model-lane.ts", "text-link")
      ])
    ], "details-stack")
  ];
}

function itemsPanel(title, items, emptyText) {
  const values = Array.isArray(items) ? items : [];
  return panel(title, [values.length ? list(values) : paragraph(emptyText)]);
}

const texts = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
const description = (value, unknown = "Bilinmiyor; okunan kaynakta çözümlenemedi.") =>
  typeof value === "string" && value.trim() ? value : texts(value).join(" · ") || unknown;

function sourceReference(source, line) {
  const name = description(source?.name, "Kaynak adı bilinmiyor");
  const locationText = Number.isInteger(line) && line > 0 ? " · satır " + line : "";
  if (source?.kind === "web") return documentLink(name + " ↗", source.url) || node("p", name);
  const url = webLink(source?.url);
  if (!url) {
    const excerpt = locationText && source?.excerpt?.(line);
    return excerpt ? details(name + locationText, [node("pre", excerpt)]) : node("p", name + locationText);
  }
  const address = new URL(url);
  if (locationText) address.hash = "L" + line;
  return link(name + locationText + " ↗", address.href, "text-link");
}

function quotedEvidence(item) {
  return [
    sourceReference(item.source, item.line),
    ...(item.quote && !item.source?.excerpt?.(item.line) ? [node("pre", item.quote)] : [])
  ];
}

function provenanceView(record) {
  const provenance = record.provenance;
  const snapshot = provenance?.snapshot;
  const read = Array.isArray(provenance?.read) ? provenance.read.filter((item) => item && typeof item.name === "string") : [];
  const version = provenance?.version;
  const fullSha = typeof version?.sha === "string" && /^[a-f0-9]{40}$/i.test(version.sha);
  const versionContent = fullSha ? [
    node("p", "Dal: " + description(version.branch, "Bilinmiyor")),
    node("p", [node("span", "Sürüm kimliği "), node("code", version.sha)]),
    ...(record.archive ? [node("p", record.archive.cached ? "Aynı sürümün önceden okunan yerel kopyası kullanıldı." : "Bu sürümün arşivi GitHub’dan alındı.")] : []),
    ...(webLink(version.url) ? [link("Okunan sürümü GitHub’da aç ↗", webLink(version.url), "text-link")] : [])
  ] : record.document ? [
    paragraph("Belge bu internet adresinden alındı: " + record.url),
    ...(record.document.requestedUrl && record.document.requestedUrl !== record.url ? [paragraph("İlk verilen adres: " + record.document.requestedUrl)] : [])
  ] : [paragraph(record.archive ? "Yüklediğin ZIP’in içeriği incelendi. Dosya adından GitHub sürümü belirlenemez." : "Seçtiğin yerel kaynak incelendi.")];
  const readContent = read.length ? read.slice(0, 6).map((item) => sourceReference(item)) :
    [paragraph("Okunan dosyaların ayrı kaydı yok; yalnız dosya listesine bakarak içerikleri okunmuş sayılmaz.")];
  if (read.length > 6) readContent.push(details((read.length - 6) + " dosya daha", read.slice(6).map((item) => sourceReference(item))));
  return node("div", [
    panel("Gerçekten içeriği okunanlar", readContent),
    panel(record.document ? "Belgenin adresi" : "Okunan sürüm", versionContent),
    ...(snapshot ? [panel("İnceleme kapsamı", [
      paragraph(`${snapshot.fileCount} dosya listelendi. ${snapshot.readCount} dosyanın içeriği incelemeye alındı.`),
      paragraph(record.document ? "Belge metni yerel hizmet tarafından okundu. Yapay zekâya gönderilmedi." :
        snapshot.cloudAllowed ? "Herkese açık kaynak için yapay zekâ incelemesi kullanılabilir." : "Bu kaynağın içeriği bilgisayarında işlendi."),
      details("Dosya özetlerini aç", [
        paragraph("Okunan dosyaların yolları ve içerikleri eşleştiğinde bu özet de eşleşir."),
        node("p", [node("span", "Okunan içerik "), node("code", snapshot.evidenceSha256)]),
        ...(snapshot.artifactSha256 ? [node("p", [node("span", "Kaynak dosyası "), node("code", snapshot.artifactSha256)])] : [])
      ])
    ])] : [])
  ], "list-grid");
}

function inspectionView(record) {
  const stages = record.inspection;
  if (!stages?.length) return [];
  const statuses = { ok: "Tamamlandı", partial: "Kısmen tamamlandı", skipped: "Atlandı", unavailable: "Kullanılamadı",
    unsupported: "Desteklenmiyor", failed: "Tamamlanamadı", error: "Tamamlanamadı" };
  return [details("İnceleme adımlarını aç", [node("div", stages.map(stage =>
    panel(stage.name === "rea" ? "REA" : "Yapay zekâ", [
      node("p", statuses[stage.status] || "Durum bilinmiyor", "inspection-status"),
      paragraph(description(stage.detail)),
      ...(stage.model ? [node("p", [stage.model, stage.provider].filter(Boolean).join(" · "))] : []),
      ...stage.evidence.slice(0, 4).map(item => node("p", [
        ...(item.label ? [node("span", item.label + " ")] : []), sourceReference(item.source, item.line)
      ]))
    ])
  ), "list-grid")])];
}

function skillView(skill) {
  return panel("Beceri ne zaman, neyle ve ne için kullanılır?", [
    node("p", "SKILL.md yönergesi metin olarak incelendi; talimatları veya komutları çalıştırılmadı."),
    flow([
      ["Ne zaman devreye girer?", description(skill.trigger)],
      ["Girdi", description(skill.input)],
      ["Çıktı", description(skill.output)],
      ["Sonuç nerede kullanılır?", description(skill.use)],
      ["Gereksinimler", description(skill.requirements)]
    ])
  ]);
}

function workflowView(workflow) {
  const jobs = Array.isArray(workflow.jobs) ? workflow.jobs.filter((job) => job && typeof job.id === "string") : [];
  const links = Array.isArray(workflow.links) ? workflow.links.filter(item => item &&
    typeof item.output === "string" && jobs.some(job => job.id === item.from) && jobs.some(job => job.id === item.to)) : [];
  const label = node("label", "İncelenecek iş");
  label.htmlFor = "workflow-job";
  const select = node("select", jobs.map((job, index) => {
    const option = node("option", job.id + (job.name ? " · " + job.name : ""));
    option.value = String(index);
    return option;
  }));
  select.id = label.htmlFor;
  const detail = node("div", null, "workflow-detail");
  function workButton(id) {
    const jump = node("button", id, "workflow-jump text-link");
    jump.type = "button";
    jump.addEventListener("click", () => {
      select.value = String(jobs.findIndex(job => job.id === id));
      showJob();
      focusHeading(detail.querySelector("h4"));
    });
    return jump;
  }
  function outputPath(item, current) {
    const from = current === item.from ? node("span", item.from) : workButton(item.from);
    const to = current === item.to ? node("span", item.to) : workButton(item.to);
    const citations = [
      ["Çıktıyı tanımlayan adım", item.producerLine], ["İşin çıkışına bağlandığı yer", item.sourceLine], ["Sonucun bağlandığı yer", item.line]
    ].filter(([, line]) => Number.isSafeInteger(line) && line > 0);
    return node("li", [
      node("p", [from, node("span", ` işinin ${item.output} çıktısı → `), to]),
      ...(item.field ? [node("p", `Bu çıktı, sonraki işin bir ayarına veya verisine bağlanıyor (${item.field}${item.step ? ` · adım ${item.step}` : ""}). Kaynak bu bağlantıyı tarif ediyor.`)] : []),
      ...(citations.length ? [details("Kaynak satırlarını aç", [node("ul", citations.map(([label, line]) => node("li", [
        node("strong", label), sourceReference(workflow.source, line)
      ])), "inline-list")])] : [])
    ]);
  }
  function showJob() {
    const job = jobs[Number(select.value)];
    if (!job) return;
    const needs = texts(job.needs);
    const outputs = texts(job.outputs);
    const consumed = texts(job.consumes);
    const needsDescription = needs.length ? needs.map(id => id + (jobs.some(candidate => candidate.id === id) ? "" : " (tanımı bulunamadı)")).join(" · ") : "Kaynakta önce tamamlanması gereken bir iş adı görülmedi.";
    const bindings = links.filter(item => item.to === job.id);
    const consumers = links.filter(item => item.from === job.id);
    const unresolved = consumed.filter(reference => !bindings.some(item => `${item.from}.${item.output}` === reference));
    detail.replaceChildren(
      heading(job.name || job.id, 4),
      sourceReference(workflow.source, job.line),
      flow([
        ["Önce hangi iş?", needsDescription],
        ["Hangi çıktı adları tanımlı?", outputs.join(" · ") || "Kaynakta çıktı adı bulunamadı."],
        ["Nerede çalışması isteniyor?", description(job.runner, "Çalışma ortamı kaynakta belirlenemedi.")]
      ]),
      heading("Bu iş sonucu kimden alır?", 4),
      bindings.length ? node("ul", bindings.map(item => outputPath(item, job.id)), "binding-list") : node("p", "Bu işe gelen bir çıktı yolu belirlenemedi."),
      heading("Bu işin çıktısını kim kullanır?", 4),
      consumers.length ? node("ul", consumers.map(item => outputPath(item, job.id)), "binding-list") : node("p", "Bu işten çıkan sonucu alan başka bir adım belirlenemedi."),
      ...(unresolved.length ? [details("Çözümlenemeyen çıktı ifadeleri", [list(unresolved)])] : []),
      node("p", "Yukarıda kaynakta tanımlanan yollar var. Gerçek çıktı değerleri bu akış çalıştırıldığında oluşur.", "field-note")
    );
  }
  select.addEventListener("change", showJob);
  if (jobs.length) showJob();
  return panel("İş akışındaki işler", [
    sourceReference(workflow.source),
    node("p", "Akışı başlatan olaylar · " + description(workflow.triggers)),
    node("p", "Bir iş seçip hangi sonucu verdiğini ve o sonucu kimin aldığını görebilirsin."),
    ...(jobs.length ? [node("div", [label, select], "workflow-select"), detail] : [node("p", "İş tanımları çözümlenemedi; akış bilinmiyor.")]),
    details("Akış okumasının sınırları", [
      texts(workflow.limitations).length ? list(texts(workflow.limitations)) : node("p", "Ek ayrıştırma bilgisi yok."),
      node("p", "YAML doğrulaması, koşulların değerlendirilmesi ve gerçek yürütme yapılmadı.")
    ])
  ]);
}

function archiveWorkflows(record) {
  const workflows = record.workflows || [];
  const sources = record.workflowSources || [];
  if (!sources.length) return record.workflow ? workflowView(record.workflow) : null;
  if (sources.length === 1 && workflows.length === 1) return workflowView(workflows[0]);

  const byFile = new Map(workflows.map(workflow => [workflow.source.name, workflow]));
  const select = node("select", sources.map((source) => {
    const option = node("option", source.name.replace(/^\.github\/workflows\//i, ""));
    option.value = source.name;
    return option;
  }));
  const label = node("label", "İş akışı dosyası");
  select.id = label.htmlFor = "workflow-file";
  select.value = record.workflow?.source.name || sources[0].name;
  const detail = node("div", null, "workflow-file-detail");
  function showWorkflow() {
    const workflow = byFile.get(select.value);
    const source = sources.find(item => item.name === select.value);
    detail.replaceChildren(workflow ? workflowView(workflow) : panel("İş akışı ayrıntısı", [
      sourceReference(source),
      node("p", "Bu dosya için iş adımları çıkarılamadı. Erişim ve kapsam bölümünde inceleme sınırlarını görebilirsiniz.")
    ]));
  }
  select.addEventListener("change", showWorkflow);
  showWorkflow();
  return node("section", [heading("GitHub iş akışları", 3), node("div", [label, select], "workflow-select"), detail], "detail-shell");
}

function jobPath(pathPrefix, section, job) {
  return pathPrefix + "/" + section + "/is/" + encodeURIComponent(job.id);
}

function jobFacts(job) {
  const rows = [["Ne üretir?", job.output], [jobUseLabel(job), job.consumer || "Sonucu alan adım belirlenemedi."]];
  return node("dl", rows.map(([label, value]) => node("div", [node("dt", label), node("dd", description(value))])), "job-facts");
}

function jobUseLabel(job) {
  return job.origin === "model" ? "Nerede kullanılabilir?" : "Sonucu kim alır, ne yapar?";
}

function runLabel(job) {
  return job.run.mode === "simulation" ? "Örneği canlandır" : "Çalıştır";
}

function trialMode(job) {
  const mode = job.run?.mode;
  if (mode === "bounded") return "Kaynakta bulunan işlemin desteklenen kısmı yazdığın girdiyle hesaplanır. Çıktıyı kullanan adım ayrıca çalıştırılmaz.";
  if (mode === "preview") return "Yazdığın dosya adları ve kaynaktaki kural kullanılarak bir taşıma planı hesaplanır. Dosyalar taşınmaz. Listedeki aynı adlı dosyalar fark edilir; hedef klasör ayrıca taranmaz.";
  if (mode === "pinned") return "Bu denemede kaynağın belirli bir sürümündeki komut, örnek girdinle çalışır.";
  if (mode === "simulation") return "Bu denemede örnek verilerle akış canlandırılır.";
  return "Bu iş için hazırlanmış örnek, yazdığın girdiyle denenir.";
}

function filePlanRows(rows) {
  const table = node("table", [
    node("thead", [node("tr", [node("th", "Dosya"), node("th", "Nereye gider?"), node("th", "Durum")])]),
    node("tbody", rows.map(row => node("tr", [
      node("td", row.from),
      node("td", row.to || (row.status === "unresolved" ? "Belirlenemedi" : "Yerinde kalır")),
      node("td", row.reason || (row.status === "planned" ? "Taşınması planlanır" : "Değişmez"))
    ])))
  ], "file-plan-table");
  return node("div", [table], "file-plan-wrap");
}

function jobExplanation(job) {
  const explanation = job.explanation;
  if (!explanation || (!explanation.scenario && !explanation.steps.length)) return null;
  return node("section", [
    heading("Bir örnekle görelim", 3),
    ...(explanation.scenario ? [paragraph(explanation.scenario)] : []),
    ...(explanation.steps.length ? [flow(explanation.steps.map(step => [step.label, step.text]))] : []),
    ...(explanation.example?.rows.length ? [filePlanRows(explanation.example.rows),
      node("p", "Bu örnek kaynakta anlatılan kurala dayanır.", "field-note")] : [])
  ], "worked-example");
}

function overviewGuide(guide) {
  if (!guide) return null;
  return node("section", [
    heading("Bir örnek üzerinden", 3),
    paragraph(guide.situation),
    node("ol", guide.steps.map(step => node("li", [
      node("strong", step.title), node("p", step.description)
    ])), "guide-steps"),
    node("p", guide.payoff, "guide-payoff"),
    node("p", "Bu anlatım, okunan kaynağa dayanarak hazırlanmış bir örnektir.", "field-note"),
    details("Örneğin dayandığı kaynakları aç", [node("ul", [
      ...guide.steps.map(step => node("li", quotedEvidence(step.evidence))),
      node("li", quotedEvidence(guide.payoffEvidence))
    ], "inline-list")])
  ], "worked-example");
}

function sourceJobCards(record, pathPrefix, section) {
  const jobs = record.jobs || [];
  if (!jobs.length) return [];
  const isOverview = section === "buyuk-resim";
  const isTrialList = section === "deneme";
  const cards = (items) => node("div", items.map(job => {
    const actions = [link(isTrialList ? "Akışı aç" : "Bu işi aç", jobPath(pathPrefix, "buyuk-resim", job),
      isTrialList && job.run ? "button secondary" : "button primary")];
    if (isTrialList && job.run) actions.unshift(link(runLabel(job), jobPath(pathPrefix, "deneme", job), "button primary"));
    return node("article", [
      heading(job.title, 4), paragraph(description(job.summary)),
      ...(job.origin === "model" ? [node("p", "Yapay zekânın kaynak üzerinden yorumu", "field-note")] : []),
      ...(isTrialList ? [node("p", job.run ? trialMode(job) : job.trialNote || "Bu iş için hazır bir deneme bulunamadı.", "field-note")] : []),
      node("div", actions, "job-actions")
    ], "panel job-card");
  }), "job-cards");
  return [node("section", [
    heading(isOverview ? "Önce bu işe bak" : "Bu kaynağın işleri", 3),
    cards(isOverview ? jobs.slice(0, 1) : jobs),
    ...(isOverview && jobs.length > 1 ? [node("div", [details("Diğer işler (" + (jobs.length - 1) + ")", [cards(jobs.slice(1))])], "details-stack")] : [])
  ], "group")];
}

function sourceTrialMeaning(job, input, output, overview) {
  if (job.run.command === "he --encode") {
    const example = [["<", "&#x3C;"], ["&", "&#x26;"], ["©", "&#xA9;"]]
      .find(([character, code]) => input.includes(character) && output.includes(code));
    return {
      purpose: "Web sayfasında göstermek istediğin işaretleri, tarayıcının metin olarak okuyabileceği biçime çevirir.",
      usage: example ? node("p", [
        "Bir web sayfasının HTML koduna ", node("code", example[0] === "<" ? "3 " + example[1] + " 5" : example[1]),
        " yazıldığında tarayıcı sayfada ", node("code", example[0] === "<" ? "3 < 5" : example[0]), " gösterir."
      ]) : "Bir web sayfasının HTML kodunda kullanılır. Tarayıcı bu gösterimleri okuyup sayfada asıl işaretleri gösterir."
    };
  }
  if (job.id === "python:gitingest.ingestion.ingest_query") {
    return {
      purpose: "Dosyaların adlarını ve içeriğini tek metinde toplar. Böylece dosyaları tek tek açmadan ne içerdiğini görebilirsin.",
      usage: "Gitingest bu metni komut ekranında gösterir veya seçtiğin dosyaya yazar. Metni, projeyi incelemesi için bir yapay zekâ asistanına verebilirsin."
    };
  }
  const verified = job.run.verifiedUses || [];
  const inTests = verified.length && verified.every(item => item.kind === "test" || (!item.kind &&
    /(?:^|[\/._-])(?:__tests__|tests?|spec)(?:[\/._-]|$)/i.test(item.source?.name ?? "")));
  const inExamples = verified.length && verified.every(item => item.kind === "example");
  const sameExample = overview?.example && verified.some(item => item.line === overview.example.line && item.source?.name === overview.example.source?.name);
  const sourceUse = job.origin === "source" && job.consumer ? job.consumer : inTests ? "Depodaki test bu sonucu alıyor." :
    inExamples ? "Depodaki örnek, bu çıktının nasıl kullanılabileceğini gösteriyor." : "Kaynakta bu çıktıyı alan bir adım görüldü.";
  return {
    purpose: description(job.summary, "Bu çıktının neye yaradığı okunan koddan belirlenemedi."),
    usage: verified.length ? [
      node("p", sourceUse),
      ...(inTests && sameExample && overview.usage ? [node("p", overview.usage + (overview.origin === "model" ? " Bu kullanım, kaynak üzerinden yapılan yorumdur." : ""))] : []),
      details("Sonucu alan kaynak satırlarını aç", [node("ul", verified.map(item => node("li", quotedEvidence(item))), "inline-list")])
    ] : "Deneme sonucu burada görünür. Üründe bu sonucu alan adım belirlenemedi."
  };
}

function sourceJobRun(job, overview) {
  const input = node("textarea");
  input.id = "repo-run-input";
  input.rows = 4;
  input.maxLength = 2000;
  input.required = job.run.mode !== "bounded";
  input.value = job.run.sampleInput ?? "# Merhaba\nBu bir deneme dosyası.";
  const label = node("label", job.run.inputLabel || "Örnek dosya içeriği");
  label.htmlFor = input.id;
  const submit = node("button", runLabel(job), "button primary");
  submit.type = "submit";
  const status = node("p", "", "field-note");
  status.setAttribute("role", "status");
  const result = node("div");
  const form = node("form", [label, input, submit], "guidance-form");
  if (job.run.mode === "preview") {
    const picker = node("input");
    picker.type = "file";
    if ("webkitdirectory" in picker) {
      picker.webkitdirectory = true;
      picker.multiple = true;
      picker.hidden = true;
      const pick = node("button", "Klasörden dosya adlarını al", "button secondary");
      pick.type = "button";
      pick.addEventListener("click", () => picker.click());
      picker.addEventListener("change", () => {
        const files = Array.from(picker.files || []);
        const names = files.map(file => {
          const relative = file.webkitRelativePath || file.name;
          const slash = relative.indexOf("/");
          return slash < 0 ? relative : relative.slice(slash + 1);
        });
        const value = names.join("\n");
        if (!names.length || names.length > 50 || value.length > input.maxLength) {
          status.textContent = "Klasörde 1–50 dosya olmalı ve adların toplamı 2.000 karakteri aşmamalı. Daha küçük bir klasör seçebilir veya adları yazabilirsin.";
          picker.value = "";
          return;
        }
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        status.textContent = names.length + " dosyanın adı alındı. Önizlemek istediğin adları düzenleyebilirsin.";
        picker.value = "";
      });
      form.insertBefore(pick, submit);
      form.insertBefore(picker, submit);
      form.insertBefore(node("p", "Seçtiğin klasörün adları, kuraldaki kaynak klasördeymiş gibi denenir; klasörün diskteki yeri doğrulanmaz. Yalnız dosya adları ve alt klasör yolları alınır, içerikler okunmaz. Çalıştır’a basınca adlar bu bilgisayardaki Ürün Tanı hizmetine gönderilir. En fazla 50 dosya ve toplam 2.000 karakter.", "field-note"), submit);
    }
  }
  input.addEventListener("input", () => {
    repoRunRequest?.abort();
    repoRunRequest = undefined;
    submit.disabled = false;
    status.textContent = "";
    result.replaceChildren();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitted = input.value;
    if (job.run.mode !== "bounded" && !submitted.trim()) {
      status.textContent = "Deneme için bir metin yazın.";
      return;
    }
    repoRunRequest?.abort();
    const controller = new AbortController();
    repoRunRequest = controller;
    const timeout = AbortSignal.timeout(90000);
    submit.disabled = true;
    result.replaceChildren();
    status.textContent = "Girdi işleniyor…";
    try {
      const response = await fetch("/api/repo-run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "omit", redirect: "error",
        body: JSON.stringify({ id: job.run.id, input: submitted }), signal: AbortSignal.any([controller.signal, timeout])
      });
      const data = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(description(data?.error, "Yerel deneme tamamlanamadı."));
      if (typeof data?.output !== "string") throw new Error("Çalıştırma çıktısı alınamadı.");
      const preview = job.run.mode === "preview" ? data.preview : null;
      if (job.run.mode === "preview" && (!preview || !Array.isArray(preview.rows) || !preview.rows.every(row =>
        typeof row?.from === "string" && (typeof row.to === "string" || row.to === null) &&
        ["planned", "unchanged", "unresolved"].includes(row.status)))) {
        throw new Error("Dosya önizlemesi alınamadı.");
      }
      result.append(trialResult({
        input: submitted,
        output: preview ? (preview.rows.length ? filePlanRows(preview.rows) : node("p", "Gösterilecek dosya yok.")) :
          data.output ? node("pre", data.output) : node("p", "Çıktı boş metin."),
        ...(preview ? {
          purpose: "Bu plan, yazdığın örnek dosyalardan hangilerinin seçilen kurala uyduğunu ve nereye gideceğini gösterir.",
          usage: "Taşınacak dosyaları ve hedefleri önceden gözden geçirebilirsin. Bu hesaplama dosyaları taşımaz."
        } : sourceTrialMeaning(job, submitted, data.output, overview))
      }));
      if (typeof data.detail === "string" && data.detail.trim()) {
        result.append(details("Çalıştırma ayrıntısı", [node("p", data.detail)]));
      }
      status.textContent = job.run.mode === "simulation" ? "Canlandırma tamamlandı." : "Sonuç hazır.";
    } catch (error) {
      if (controller.signal.aborted) return;
      status.textContent = timeout.aborted ? "Çalıştırma süresi doldu. Yeniden deneyin." :
        "Çalıştırma başarısız. " + (error instanceof TypeError ? "Yerel hizmete ulaşılamadı." : error.message);
    } finally {
      if (repoRunRequest === controller) {
        repoRunRequest = undefined;
        submit.disabled = false;
      }
    }
  });
  return panel("Bu işi kendin dene", [
    paragraph(trialMode(job)),
    ...(job.run.description ? [paragraph(job.run.description)] : []),
    ...(job.run.command ? [details("Çalışan komutu gör", [node("code", job.run.command)])] : []),
    form, status, result
  ]);
}

function sourceJobDetail(job, section, pathPrefix, page, overview) {
  const isRun = section === "deneme" && job.run;
  const explanation = !isRun ? jobExplanation(job) : null;
  const uses = job.run?.verifiedUses || [];
  const consumerEvidence = [...new Map([...job.evidence.filter(item => item.role === "consumer"), ...uses]
    .map(item => [item.source?.name + ":" + item.line, item])).values()];
  const isConsumer = page === "sonraki-adim" && consumerEvidence.length > 0;
  const possibleUse = jobUseLabel(job) === "Nerede kullanılabilir?";
  const evidenceRows = items => node("ul", items.map(item => node("li", [
    ...(item.recipient ? [node("span", "Sonucu alan " + item.recipient)] : item.label ? [node("span", item.label)] : []),
    ...(item.conditional ? [node("p", "Bu yol yalnız ilgili koşul gerçekleşirse devreye girer.")] : []),
    ...quotedEvidence(item)
  ])), "inline-list");
  const flowPath = jobPath(pathPrefix, "buyuk-resim", job);
  if (isConsumer) return [
    link("← İşe dön", flowPath, "back-link"),
    heading(possibleUse ? "Olası kullanım" : "Sonucu kullanan adım"),
    paragraph(description(job.consumer)),
    paragraph(possibleUse ? "Yapay zekâ bu kullanımı kaynak üzerinden önerdi." : "Bu yol kaynakta görülüyor. Deneme, ilgili başka adımın da çalıştığını göstermez."),
    node("div", [panel(possibleUse ? "Bu yorumla ilgili kaynak satırları" : "İlgili kaynak satırları", [evidenceRows(consumerEvidence)])], "detail-shell")
  ];
  const work = panel("Nasıl işler?", [
    ...(job.origin === "model" ? [node("p", "Yapay zekânın kaynak üzerinden yorumu", "field-note")] : []),
    flow([
      ["Ne başlatır?", description(job.trigger)],
      ["Ne yapar?", description(job.summary)]
    ]),
    jobFacts(job),
    ...(consumerEvidence.length ? [link(possibleUse ? "Olası kullanımı aç" : "Sonraki adımı aç", flowPath + "/sonraki-adim", "text-link")] : []),
    ...(job.evidence.length ? [details("Kaynak satırlarını aç", [evidenceRows(job.evidence)])] : [])
  ]);
  const trial = isRun ? sourceJobRun(job, overview) : panel("Deneme", [
    job.run ? node("p", trialMode(job)) :
      node("p", job.trialNote || "Bu iş için hazır bir deneme bulunamadı. Yukarıdaki kaynak satırlarından inceleyebilirsin."),
    ...(job.run ? [link(runLabel(job), jobPath(pathPrefix, "deneme", job), "button primary")] : [])
  ]);
  return [
    back(isRun ? "Denemelere dön" : "Büyük resme dön", pathPrefix.slice(1) + (isRun ? "/deneme" : "/buyuk-resim")),
    heading(job.title),
    ...(explanation ? [explanation] : []),
    node("div", [work, trial], "detail-shell job-detail")
  ];
}

function modernGuidance(record, skill) {
  const repo = typeof record.url === "string" ? record.url.replace(/\/$/, "").toLowerCase() : "";
  const id = String(skill.id || "").toLowerCase();
  const name = String(skill.source?.name || "").toLowerCase();
  return repo === "https://github.com/googlechrome/modern-web-guidance" &&
    (id === "modern-web-guidance" || /(^|\/)modern-web-guidance\/skill\.md$/.test(name));
}

function chromeExtensions(record, skill) {
  const repo = typeof record.url === "string" ? record.url.replace(/\/$/, "").toLowerCase() : "";
  const name = String(skill.source?.name || "").toLowerCase();
  return repo === "https://github.com/googlechrome/modern-web-guidance" && name === "skills/chrome-extensions/skill.md";
}

function skillCards(record, pathPrefix) {
  const skills = Array.isArray(record.skills) ? record.skills.filter((skill) => skill && typeof skill.id === "string") : [];
  if (!skills.length) return [];
  return [node("section", [
    node("div", [heading("Bulunan beceriler", 3), node("span", skills.length + " beceri", "count")], "group-title"),
    node("div", skills.map((skill) => {
      const card = link("", pathPrefix + "/buyuk-resim/beceri/" + encodeURIComponent(skill.id), "work-card");
      card.append(node("strong", description(skill.title, skill.id)), node("span", "→", "card-arrow"),
        node("p", modernGuidance(record, skill) ? "Web geliştirme sorunuza uygun güncel rehberi bulur ve içeriğini getirir." : chromeExtensions(record, skill) ? "Chrome eklentisi geliştirme, düzeltme ve yayımlama için asistana rehberlik eder." : "Beceri tanımını ve kaynağını inceleyin."));
      return card;
    }), "card-list")
  ], "group")];
}

function guidanceExperiment() {
  if (!globalThis.urunTanimaKaynak?.localService()) {
    return panel("Bu beceriyi kendin dene", [
      node("p", "Deneme için Ürün Tanı'nın yerel hizmetiyle açılması gerekir. PowerShell'de şu komutu çalıştırın:"),
      node("pre", "node uygulama/sunucu.cjs"),
      link("Yerel Ürün Tanı'yı aç →", "http://127.0.0.1:4178/", "button secondary"),
      node("p", "Açılan sayfada GitHub bağlantısını yeniden girerek bu beceriyi seçin.")
    ]);
  }
  const input = node("input");
  input.id = "guidance-query";
  input.type = "text";
  input.maxLength = 200;
  input.required = true;
  input.value = "animate a dialog modal backdrop";
  const label = node("label", "Web geliştirme sorunuzu yazın (en fazla 200 karakter)");
  label.htmlFor = input.id;
  const submit = node("button", "Rehber ara", "button primary");
  submit.type = "submit";
  const status = node("p", "", "field-note");
  status.setAttribute("role", "status");
  const result = node("div");
  const form = node("form", [label, input, submit], "guidance-form");
  let sequence = 0;
  let controller;
  input.addEventListener("input", () => {
    sequence += 1;
    if (controller) controller.abort();
    result.replaceChildren();
    status.textContent = "";
    submit.disabled = false;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query || query.length > 200) {
      status.textContent = "1 ile 200 karakter arasında bir soru yazın.";
      return;
    }
    const current = ++sequence;
    if (controller) controller.abort();
    controller = new AbortController();
    submit.disabled = true;
    result.replaceChildren();
    status.textContent = "Rehber aranıyor…";
    try {
      const response = await fetch("/api/modern-web-guidance", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }), signal: controller.signal
      });
      const data = await response.json();
      if (current !== sequence) return;
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Deneme tamamlanamadı.");
      if (!Array.isArray(data?.matches)) throw new Error("Hizmetten beklenen arama sonucu alınamadı.");
      const matches = data.matches.filter((item) => item && typeof item.id === "string");
      const guide = data.guide && typeof data.guide.text === "string" ? data.guide : null;
      result.append(trialResult({
        input: query,
        output: [
          node("p", matches.length ? matches.length + " rehber bulundu." : "Soruna uygun rehber bulunamadı.", "trial-value"),
          ...(guide ? [node("p", ["Açılan rehber ", node("code", description(guide.id, "adı belirtilmedi"))])] : []),
          ...(matches.length ? [details("Bulunan rehberleri gör", [
            list(matches.map((item) => item.id + (typeof item.description === "string" && item.description ? " — " + item.description : "")))
          ])] : []),
          ...(guide ? [details("Rehberin özgün metnini aç", [
            node("p", "Rehberin özgün metni İngilizce."),
            node("pre", guide.text)
          ])] : [])
        ],
        purpose: guide ? "Soruna uygun bir web geliştirme yolunu ve örneklerini bulmana yardım eder." :
          matches.length ? "Sorunla ilgili hangi rehberlerin bulunduğunu gösterir." :
          "Bu aramayla devam edebileceğin bir rehber bulunmadığını gösterir.",
        usage: guide ? "Bu beceriyi kullanan yapay zekâ asistanı, rehberi yanıtında veya yazdığı kodda kullanabilir." :
          "Bu denemede rehber metni açılmadı."
      }));
      status.textContent = guide ? "Arama ve rehberi getirme tamamlandı." : "Arama tamamlandı; bir rehber içeriği getirilmedi.";
    } catch (error) {
      if (current !== sequence || error.name === "AbortError") return;
      status.textContent = "Deneme başarısız: " + (error.message || "Yerel hizmete ulaşılamadı.");
    } finally {
      if (current === sequence) submit.disabled = false;
    }
  });
  return panel("Bu beceriyi kendin dene", [
    node("p", "Soruyu yerel arama aracına gönderir; bulunan rehberleri ve getirilen rehberin metnini gösterir. Örnek soru İngilizcedir."),
    form, status, result
  ]);
}

function sourceSkillDetail(record, skill, pathPrefix) {
  const known = modernGuidance(record, skill);
  const extension = chromeExtensions(record, skill);
  const fields = skill.fields && typeof skill.fields === "object" ? skill.fields : {};
  const unknown = "Okunan kaynakta açıkça belirlenemedi.";
  const steps = known ? [
    ["Ne zaman devreye girer?", "Bir yapay zekâ asistanı, modern web geliştirmeyle ilgili rehbere ihtiyaç duyduğunda bu beceri yönergesini kullanabilir."],
    ["Ne alır?", "Web geliştirmeye ilişkin arama sorusu."],
    ["Ne yapar?", "Önce soruyla ilgili rehberleri arar; ardından seçilen rehberin içeriğini getirir."],
    ["Ne üretir?", "Eşleşen rehberlerin listesi ve seçilen rehberin metni."],
    ["Sonuç nereye gider?", "Rehber metni, onu isteyen asistana döner; asistan bu bilgiyi yanıtında veya çalışmasında kullanabilir."]
  ] : extension ? [
    ["Ne zaman devreye girer?", "Chrome eklentisi oluşturma, değiştirme, sorun giderme, anlama veya yayımlama talebi geldiğinde asistan bu beceriyi kullanabilir."],
    ["Ne alır?", "Eklentiyle ilgili kullanıcı isteğini ve varsa üzerinde çalışılan eklenti bilgilerini."],
    ["Ne yapar?", "Asistana Manifest V3 geliştirme kurallarını, örneklerini ve mağazaya hazırlık rehberini sunar."],
    ["Ne üretir?", "Kendi başına çalışan bir program değil, asistanın kullanacağı geliştirme ve yayımlama yönergeleridir."],
    ["Sonuç nereye gider?", "Asistan bu yönergeleri eklenti kodunu hazırlarken veya düzeltirken ve Chrome Web Store hazırlığında kullanabilir."]
  ] : [
    ["Ne zaman devreye girer?", description(fields.trigger, unknown)],
    ["Ne alır?", description(fields.input, unknown)],
    ["Ne yapar?", description(fields.process, unknown)],
    ["Ne üretir?", description(fields.output, unknown)],
    ["Sonuç nereye gider?", description(fields.use, unknown)]
  ];
  return [
    back("Becerilere dön", pathPrefix.slice(1) + "/buyuk-resim"),
    node("header", [node("p", "Beceri", "module-group"), heading(description(skill.title, skill.id)),
      paragraph(known ? "Web geliştirme sorunuza uygun rehberi bulur ve içeriğini getirir." : extension ? "Chrome eklentisi geliştirme, düzeltme ve yayımlama için asistana rehberlik eder." : "Kaynakta bulunan bu becerinin bilgilerini inceleyin.")], "module-head"),
    node("div", [panel("Nasıl çalışır?", [flow(steps)])], "detail-shell"),
    node("div", [known ? guidanceExperiment() : panel("Bu beceriyi kendin dene", [node("p", "Bu beceri için henüz hazır bir çalıştırma denemesi yok. Kaynağın okunmuş olması becerinin çalıştırıldığı anlamına gelmez.")])], "detail-shell"),
    node("div", [details("Kaynak açıklaması ve dosya", [
      node("p", "Kaynak açıklaması (özgün dilinde): " + description(skill.summary, "Açıklama bulunamadı.")),
      sourceReference(skill.source),
      node("p", "Yönergenin okunması, bütün adımların çalıştırıldığını göstermez.")
    ])], "details-stack")
  ];
}

function webDocumentView(section, title, record, pathPrefix) {
  const document = record.document;
  const preview = details("Okunan belge metnini aç", [
    node("pre", document.preview),
    ...(document.previewClipped ? [paragraph("Burada metnin ilk 4.800 karakteri gösteriliyor.")] : [])
  ]);
  if (section === "mimari") return [
    heading(title), paragraph("Bu bağlantı tek bir belgeye açılıyor. Bir proje klasörü veya kurulum dosyası incelenmedi."),
    provenanceView(record), preview
  ];
  if (section === "akis") return [
    heading(title), paragraph("Yayımlanmış metin okundu. Bu bağlantıdan hangi işin ne zaman başladığı veya çıktısının nerede kullanıldığı doğrulanamaz."),
    ...(document.headings.length ? [panel("Belgede bulunan başlıklar", [list(document.headings)])] : []), preview
  ];
  if (section === "deneme") return [
    heading(title), paragraph("Bu bağlantı okunabilir belge sağlıyor. İçindeki site veya örnek kod bu incelemede çalıştırılmadı."),
    link("Belgeye dön", pathPrefix + "/buyuk-resim", "button secondary")
  ];
  return [
    heading(title),
    paragraph(document.title ? `Bu bağlantı “${document.title}” başlıklı bir belgeye açılıyor.` : "Bu bağlantı başlığı belirlenemeyen bir metin belgesine açılıyor."),
    paragraph("Aşağıdan yayımlanmış metni okuyabilirsin. Sitenin nasıl çalıştığı ve ürettiği sonuç bu belge incelemesinde doğrulanmadı."),
    ...(document.headings.length ? [panel("Belgede hangi başlıklar var?", [list(document.headings)])] : []),
    preview,
    link("Belgenin adresini ve okuma kapsamını gör →", pathPrefix + "/mimari", "text-link")
  ];
}

function gateCapabilityRows(matrix = {}) {
  const specs = [
    ["filesystemRead", "Dosya Okuma", false],
    ["filesystemWrite", "Dosya Yazma", false],
    ["sensitivePathAccess", "Hassas Yol (.env / .ssh)", true],
    ["networkEgress", "Dış Ağ Erişimi", false],
    ["childProcess", "Alt Süreç / Kabuk Komutu", false],
    ["envSecretRead", "Ortam Değişkeni Okuma", false],
    ["promptPoisoning", "Gizli Yönerge (Poisoning)", true],
    ["desktopInput", "Masaüstü Klavye Enjeksiyonu", false]
  ];
  return node("div", specs.map(([key, label, highRisk]) => {
    const active = Boolean(matrix[key]);
    const item = node("div", [
      node("span", label),
      node("span", active ? (highRisk ? "TEHLİKE" : "GÖRÜLDÜ") : "Yok", "matrix-badge")
    ], "matrix-item");
    item.dataset.active = String(active);
    if (active && highRisk) item.dataset.danger = "true";
    return item;
  }), "matrix-grid");
}

function gateCanarySummaryNodes(canary) {
  if (!canary) return [paragraph("Bu kaynağa çalışma denemesi yapılmadı.")];
  if (!canary.executed) {
    return [paragraph(canary.reason || "Çalıştırılabilir giriş noktası bulunamadı.")];
  }
  const violations = Array.isArray(canary.runtimeViolations) ? canary.runtimeViolations : [];
  const fsChanges = canary.fsChanges || { created: [], modified: [], deleted: [] };
  const fileNames = (arr) => Array.isArray(arr) && arr.length
    ? arr.map((item) => typeof item === "string" ? item : item.path).join(", ")
    : "Yok";
  return [
    node("div", [
      node("span", "Giriş noktası: " + canary.entrypoint),
      node("span", "Ortam: " + canary.runtime),
      node("span", "Çıkış kodu: " + String(canary.exitCode ?? "Bilinmiyor"))
    ], "canary-meta"),
    ...(violations.length ? [
      node("div", violations.map((v) => node("div", [
        node("strong", "Yakalanan İhlal · " + (v.type || v.permission || "İhlal") + " (" + (v.resource || "") + ")"),
        node("p", v.summary || ""),
        ...(v.evidence ? [node("pre", v.evidence)] : [])
      ], "violation-card")), "violation-list")
    ] : [
      node("p", "Tuzak .env, sahte .ssh anahtarları ve ortam değişkeni kanaryalarına yetkisiz erişim görülmedi.", "field-note")
    ]),
    node("div", [
      node("div", [
        node("strong", "Oluşturulan (" + (fsChanges.created?.length || 0) + ")"),
        node("span", fileNames(fsChanges.created))
      ]),
      node("div", [
        node("strong", "Değiştirilen (" + (fsChanges.modified?.length || 0) + ")"),
        node("span", fileNames(fsChanges.modified))
      ]),
      node("div", [
        node("strong", "Silinen (" + (fsChanges.deleted?.length || 0) + ")"),
        node("span", fileNames(fsChanges.deleted))
      ])
    ], "canary-fs"),
    ...(canary.stdout ? [details("Standart çıktı (stdout)", [node("pre", canary.stdout)])] : []),
    ...(canary.stderr ? [details("Hata / İzin çıktısı (stderr)", [node("pre", canary.stderr)])] : [])
  ];
}

function gateCoveragePanel(record) {
  if (!record.gate?.canary) return null;
  return panel("Ne test edildi?", [
    ...gateCanarySummaryNodes(record.gate.canary),
    link("Kapı’da örnek denemeyi aç", "#basla", "text-link")
  ]);
}

function gateOverviewSection(record) {
  const gate = record.gate;
  if (!gate || !gate.verdict) return [];
  const { verdict, verdictTitle, verdictSummary, declaration, matrix = {}, findings = [] } = gate;
  const verdictLabels = {
    BLOCK: "ENGELLE · KURULUMA İZİN VERME",
    REVIEW_REQUIRED: "DİKKAT · İNSAN ONAYI GEREKLİ",
    TEST_INCOMPLETE: "TEST EKSİK"
  };
  const banner = node("section", [
    node("div", [
      node("span", verdictLabels[verdict] || "İNCELEME SONUCU", "verdict-pill")
    ], "verdict-top"),
    heading(verdictTitle || "Kabul Kapısı Kararı", 3),
    paragraph(verdictSummary || "")
  ], "verdict-banner");
  banner.dataset.verdict = verdict || "REVIEW_REQUIRED";

  const declaredBox = panel("Açıklama ve kodda görülenler", [
    node("p", "Kaynağın anlattığı amaç", "label"),
    paragraph(declaration?.declaredPurpose || "Kaynakta açık bir amaç beyanı (SKILL.md / README.md / package.json) bulunamadı."),
    ...(declaration?.declaredSource?.source ? [sourceReference(declaration.declaredSource.source, declaration.declaredSource.line)] : []),
    node("p", "Kodda ve yönergelerde görünen davranışlar", "label"),
    gateCapabilityRows(matrix)
  ]);

  const findingsBox = panel("Güvenlik işaretleri (" + findings.length + ")", [
    findings.length ? node("div", findings.slice(0, 8).map((f) => {
      const badge = node("span", f.severity, "severity-badge");
      badge.dataset.severity = f.severity;
      return node("article", [
        node("div", [
          badge,
          node("strong", f.title),
          ...(f.undeclared ? [node("span", "Beyan Edilmemiş", "undeclared-tag")] : [])
        ], "finding-head"),
        node("p", f.description),
        sourceReference(f.source, f.line),
        ...(f.quote ? [node("pre", f.quote)] : [])
      ], "finding-card");
    }), "finding-list") : paragraph("Okunan kod ve yönergelerde ek bir güvenlik işareti bulunmadı.")
  ]);

  const coverage = gateCoveragePanel(record);

  return [
    node("div", [
      banner,
      node("div", [declaredBox, findingsBox], "gate-grid"),
      ...(coverage ? [coverage] : [])
    ], "gate-section")
  ];
}

function sourceView(section, record, pathPrefix) {
  const title = sourceSections.find(([id]) => id === section)[1];
  if (record.document) return webDocumentView(section, title, record, pathPrefix);
  if (section === "mimari") {
    return [
      heading(title),
      paragraph("Dosya listesi, içeriği gerçekten okunan dosyalarla aynı şey değildir. Komutlar çalıştırılmadı ve doğrulanmadı."),
      node("div", [
        itemsPanel("Dizin listesi — içerik okuma kanıtı değildir", record.files, "Dosya listesi okunamadı."),
        itemsPanel("Çalıştırılmamış komutlar ve betikler", record.setup, "Metinde komut veya betik bulunamadı.")
      ], "list-grid"),
      provenanceView(record)
    ];
  }
  if (section === "akis") {
    const workflows = archiveWorkflows(record);
    return [
      heading(title),
      paragraph("Bu bölüm, kaynakta görülen akışları gösterir."),
      ...sourceJobCards(record, pathPrefix, section),
      ...skillCards(record, pathPrefix),
      ...(workflows ? [workflows] : []),
      ...(record.skill && typeof record.skill === "object" ? [skillView(record.skill)] : []),
      ...inspectionView(record),
      node("div", [
        itemsPanel("Kaynak bilgileri", record.signals, "Okunan kaynakta ek bilgi bulunamadı."),
        itemsPanel("Erişim ve kapsam", record.limitations, "Ek bir erişim sınırlaması bildirilmedi.")
      ], "list-grid")
    ];
  }
  if (section === "deneme") {
    const canaryPanel = gateCoveragePanel(record);
    const jobs = sourceJobCards(record, pathPrefix, section);
    const skills = skillCards(record, pathPrefix);
    const workflows = archiveWorkflows(record);
    return [
      heading(title),
      ...(canaryPanel ? [canaryPanel] : []),
      ...jobs,
      ...skills,
      ...(workflows ? [paragraph("İş akışlarını kaynak üzerinden inceleyebilirsiniz."), workflows] : []),
      ...(!canaryPanel && !jobs.length && !skills.length && !workflows ? [
        paragraph("Bu kaynaktan bir deneme hazırlanamadı. Hangi dosyaların okunduğunu inceleyebilirsiniz."),
        link("Dosyaları ve komutları aç", pathPrefix + "/mimari", "button secondary")
      ] : [])
    ];
  }
  const gateNodes = gateOverviewSection(record);
  const jobs = sourceJobCards(record, pathPrefix, section);
  const skillCount = record.skills?.length || 0;
  const visibleSkills = jobs.length ? [] : skillCards({ ...record, skills: record.skills?.slice(0, 1) }, pathPrefix);
  const hasWorkflows = Boolean(record.workflow || record.workflowSources?.length);
  const simple = record.overview;
  const example = simple?.example;
  const kind = record.provenance?.snapshot?.kind;
  const firstWorkflow = record.workflow;
  const workflowLead = firstWorkflow?.links?.[0];
  const exampleView = record.jobs?.[0] ? jobExplanation(record.jobs[0]) : null;
  const guideView = exampleView || overviewGuide(simple?.guide);
  return [
    heading(title),
    ...gateNodes,
    ...(simple?.purpose ? [node("section", [
      paragraph(simple.purpose),
      ...(simple.usage ? [paragraph(simple.usage)] : []),
      ...(example ? [node("figure", [
        node("figcaption", "Kaynakta görülen örnek"),
        node("div", [node("code", example.input), node("span", "→", "example-arrow"), node("code", example.output)], "source-example"),
        details("Örneğin kaynak satırını aç", [sourceReference(example.source, example.line)])
      ], "overview-example")] : []),
      ...(simple.origin === "model" ? [node("p", "Yapay zekâ bu açıklamayı okunan kaynaklara dayanarak hazırladı.", "field-note")] : []),
      ...(simple.evidence ? [details("Açıklamanın dayanağını aç", quotedEvidence(simple.evidence))] : [])
    ], "source-purpose")] : [paragraph(jobs.length ? "Aşağıda kaynakta bulduğumuz ilk işi açabilirsin. Ürünün genel amacı bu incelemede belirlenemedi." :
      visibleSkills.length ? "Bu kaynak, bir asistanın belirli bir görevde izleyeceği yönergeleri içeriyor." :
        firstWorkflow ? "Bu kaynak, GitHub’da belirli olaylar olduğunda hangi işlerin devreye gireceğini tarif ediyor." :
          "Bu kaynağın hangi ihtiyacı karşıladığı okunan dosyalardan belirlenemedi.")]),
    ...(guideView ? [guideView] : []),
    ...jobs,
    ...visibleSkills,
    ...(hasWorkflows && !jobs.length && !skillCount ? [node("div", [
      ...(workflowLead ? [paragraph(`İş akışında ${workflowLead.from} işinin ${workflowLead.output} adlı çıktısı, ${workflowLead.to} işinin bir ayarına veya verisine bağlanıyor.`)] : []),
      link("İş akışını aç", pathPrefix + "/akis", "button primary")
    ], "overview-workflow")] : []),
    ...(skillCount > 1 && visibleSkills.length ? [link(`Diğer becerileri gör (${skillCount - 1})`, pathPrefix + "/akis", "text-link")] : []),
    ...(!jobs.length && !skillCount && !hasWorkflows && !gateNodes.length ? [node("p", "Okunan kaynaktan bir iş çıkarılamadı. Aşağıdan hangi dosyaların okunduğunu görebilirsin.", "scope-note")] : []),
    details("İnceleme ayrıntılarını aç", [node("div", [
      panel("Dosyalar ve komutlar", [
        paragraph((record.provenance?.snapshot ? "İncelemeye alınan dosyalar " + record.provenance.snapshot.readCount : record.archive ? "Arşivde listelenen dosyalar " + record.archive.count : "Listelenen yerel öğeler " + record.files.length) + " · Görülen komut veya betikler " + record.setup.length),
        link("Dosyaları ve komutları aç →", pathPrefix + "/mimari", "button secondary")
      ]),
      panel("Kaynakta görülenler", [
        ...(skillCount > visibleSkills.length ? [paragraph(`${skillCount} beceri dosyası bulundu.`)] : []),
        ...(record.workflowSources?.length ? [paragraph(record.workflowSources.length + " GitHub iş akışı dosyası bulundu.")] : []),
        link("Kaynak bilgilerini aç →", pathPrefix + "/akis", "button secondary")
      ]),
      itemsPanel("Erişim ve kapsam", [...(kind && kind !== "github" ? ["Yerel kaynak dosyaları bilgisayarında işlendi."] : []), ...record.limitations], "Ek bir erişim sınırlaması bildirilmedi."),
      ...(record.summary ? [panel("Kaynak metnindeki açıklama", [paragraph(record.summary)])] : [])
    ], "list-grid")])
  ];
}

function webLink(url) {
  try {
    const address = new URL(url);
    if (address.origin === "https://github.com" && !address.username && !address.password) return address.href;
  } catch {
    return null;
  }
  return null;
}

function documentLink(text, url) {
  let address;
  try { address = new URL(url); } catch { return null; }
  if (address.protocol !== "https:" || address.username || address.password || address.port ||
      address.search || address.hash) return null;
  const result = link(text, address.href, "text-link");
  result.target = "_blank";
  result.rel = "noopener noreferrer";
  return result;
}

function workspaceHeader(section, record, pathPrefix) {
  const isProduct = !record;
  const subject = node("header", [node("div", [
    node("p", isProduct ? "Önceden incelenmiş örnek" : record.type, "source-kind"),
    heading(isProduct ? "Agentic OS 3.0.0" : record.name, 1)
  ])], "subject");
  if (record?.document) {
    const external = documentLink("Belgeyi kaynağında aç ↗", record.url);
    if (external) subject.append(external);
  } else {
    const report = isProduct ? sourceReport : webLink(record.url);
    if (report) subject.append(link(isProduct ? "İnceleme raporu ↗" : "GitHub’da aç ↗", report, "text-link"));
  }
  const nav = node("nav", (isProduct ? sections : sourceSections).map(([id, title]) => {
    const item = link(title, pathPrefix + "/" + id);
    if (section === id) item.setAttribute("aria-current", "page");
    return item;
  }), "nav");
  nav.setAttribute("aria-label", "İnceleme bölümleri");
  return [subject, nav];
}

function render() {
  const path = location.hash.slice(1);
  if (path === "icerik" && lastPath !== null) return;
  if (path === lastPath) return;

  const previousPath = lastPath;
  lastPath = path;
  const [mode, first, second, key, itemId, page] = path.split("/");
  const isSource = mode === sourcePath;
  const record = isSource ? sourceRecords.get(first) : null;
  const requested = isSource ? second : first;
  const pathPrefix = "#" + (isSource ? sourcePath + "/" + first : productPath);
  const section = sections.some(([id]) => id === requested) ? requested : "buyuk-resim";
  const hasWorkspace = mode === productPath || Boolean(record);
  $("laboratuvar").hidden = hasWorkspace;
  $("entry").hidden = hasWorkspace;
  $("workspace").hidden = !hasWorkspace;
  $("new-source").hidden = !hasWorkspace;
  document.title = (hasWorkspace ? (record?.name || "Agentic OS 3.0.0") + " · " : "") + "Ürün Tanı";

  requestNumber += 1;
  sourceRequest?.abort();
  repoRunRequest?.abort();
  repoRunRequest = undefined;
  $("github-form").querySelector("button").disabled = false;
  setEntryStatus(isSource && !record ? "Kaynak incelemesi yalnız açık sayfanın belleğinde tutulur. Devam etmek için dosyayı yeniden seçin veya GitHub bağlantısını tekrar girin." : "");

  if (!hasWorkspace) {
    $("workspace").replaceChildren();
    if (path === "kendi-aracini-incele") {
      $("entry").scrollIntoView();
      focusHeading($("entry-title"));
    } else {
      if (previousPath !== null && path !== "laboratuvar") focusHeading($("entry-title"));
      window.scrollTo(0, 0);
    }
    return;
  }

  const productPages = { "buyuk-resim": productHome, "mimari": productArchitecture, "akis": productFlow, "deneme": productDemos };
  let children;
  if (record) {
    const selectedSkill = key === "beceri" && Array.isArray(record.skills) ? record.skills.find((skill) => typeof skill?.id === "string" && encodeURIComponent(skill.id) === itemId) : null;
    const selectedJob = key === "is" && record.jobs?.find(job => encodeURIComponent(job.id) === itemId);
    if (selectedJob) children = sourceJobDetail(selectedJob, section, pathPrefix, page, record.overview);
    else if (selectedSkill) children = sourceSkillDetail(record, selectedSkill, pathPrefix);
    else children = sourceView(section, record, pathPrefix);
  } else if (second === "is" && Object.hasOwn(modules, key)) {
    children = moduleView(key, section);
  } else if (section === "mimari" && second === "araclari-bul") {
    const step = toolSteps.some(([id]) => id === key) ? key : "tetik";
    children = toolsView(step);
  } else if (section === "deneme" && second === "model-etiketi") {
    children = modelView();
  } else {
    children = productPages[section]();
  }
  const main = node("section", children, "view");
  $("workspace").replaceChildren(...workspaceHeader(section, record, pathPrefix), main);
  if (previousPath !== null) focusHeading(main.querySelector("h2"));
  window.scrollTo(0, 0);
}

function setEntryStatus(message, tone = "") {
  const status = $("entry-status");
  status.hidden = !message;
  status.textContent = message;
  status.dataset.tone = tone;
  $("github-zip-help").hidden = true;
  $("local-service-help").hidden = true;
}

async function examine(kind, input) {
  const currentRequest = ++requestNumber;
  sourceRequest?.abort();
  const controller = new AbortController();
  sourceRequest = controller;
  const entryHash = location.hash;
  const stillCurrent = () => currentRequest === requestNumber && entryHash === location.hash;
  const submit = $("github-form").querySelector("button");
  submit.disabled = kind === "github" || kind === "web";
  const loading = { github: "GitHub deposu okunuyor, kabul kapısı ve kum havuzu çalıştırılıyor…", web: "Bağlantıdaki belge metni okunuyor…",
    zip: "ZIP arşivi kabul kapısından geçiriliyor…", file: "Seçilen dosya kabul kapısından geçiriliyor…", folder: "Seçilen klasördeki dosyalar kabul kapısından geçiriliyor…",
    preset: "Hazır senaryonun kodu ve yönergeleri inceleniyor…" };
  setEntryStatus(loading[kind]);
  let record;
  try {
    const sourceReader = globalThis.urunTanimaKaynak;
    if (typeof sourceReader?.[kind] !== "function") {
      setEntryStatus("Kaynak okuma bileşeni yüklenemedi. Sayfayı yeniden yükleyin.", "error");
      return;
    }
    record = await sourceReader[kind](input, controller.signal);
  } catch {
    if (stillCurrent()) setEntryStatus("Kaynak okunamadı. Yeniden deneyin.", "error");
    return;
  } finally {
    if (currentRequest === requestNumber) {
      submit.disabled = false;
      sourceRequest = undefined;
    }
  }
  if (!stillCurrent()) return;
  if (record?.status === "error") {
    setEntryStatus(record.message, "error");
    if (record.githubUrl && webLink(record.githubUrl)) {
      $("github-zip-link").href = record.githubUrl;
      $("github-zip-help").hidden = false;
    }
    if (record.localService) $("local-service-help").hidden = false;
    return;
  }
  if (!["ok", "incomplete"].includes(record?.status) || !record.name || !["files", "setup", "signals", "limitations"].every((key) => Array.isArray(record[key]))) {
    setEntryStatus("İnceleme bilgileri eksik döndü. Yeniden deneyin.", "error");
    return;
  }
  const id = Array.from(crypto.getRandomValues(new Uint32Array(2)), (part) => part.toString(36)).join("-");
  sourceRecords.set(id, record);
  location.hash = sourcePath + "/" + id + "/buyuk-resim";
}

$("github-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("github-url").value.trim();
  if (value) examine(globalThis.urunTanimaKaynak?.kindFromLink?.(value) || "web", value);
  else {
    requestNumber += 1;
    sourceRequest?.abort();
    $("github-form").querySelector("button").disabled = false;
    setEntryStatus("Bir GitHub deposu veya belge bağlantısı girin.", "error");
  }
});

$("source-file").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  if (file) examine(/\.zip$/i.test(file.name) ? "zip" : "file", file);
  event.currentTarget.value = "";
});

$("pick-file").addEventListener("click", () => $("source-file").click());
$("pick-folder").addEventListener("click", () => $("source-folder").click());
$("source-folder").addEventListener("change", (event) => {
  const files = Array.from(event.currentTarget.files);
  if (files.length) examine("folder", files);
  event.currentTarget.value = "";
});

document.querySelector(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  $("icerik").focus();
});

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const presetId = btn.dataset.preset;
    if (presetId) examine("preset", presetId);
  });
});

window.addEventListener("hashchange", render);
render();
