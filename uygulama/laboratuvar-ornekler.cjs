'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { isDeepStrictEqual } = require('node:util');
// The chained-session helper behind the Agentic OS sample is not part of this repository
// (the example product was left out on purpose, see THIRD-PARTY.md). Without it only the document-finder sample is offered.
let chained = null;
try {
  chained = require('../denetim/kurtarma/teslim-7-zincir-deney-03-astra/tek-yol-sentetik-model.cjs');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
}
const { gateFlow } = require('./kapi-akis.cjs');
const { v1: documentFinder } = require('./kapi-ornek.cjs');

const AGENTIC = 'agentic-os';
const DOCUMENTS = 'belge-bulucu';
const agenticMode = 'Örnek verilerle kurulum denemesi';
const documentMode = 'Örnek dosyalarla gerçek araç denemesi';

const samples = [
  ...(chained ? [{ id: AGENTIC, title: 'Agentic OS', description: 'Codex bulunduğunda kurulum ekranında ne değişiyor?' }] : []),
  { id: DOCUMENTS, title: 'Belge Bulucu', description: 'Yazdığın kelimeyle hangi örnek belgeler eşleşiyor?' },
];

const agenticRefs = {
  record: 'src/data/live-data.json:2,3,63-65',
  reader: 'src/lib/use-live-data.ts:34-46',
  screen: 'src/routes/setup.tsx:1325-1354,1370-1379',
  initialChoice: 'src/routes/setup.tsx:191-198,417-439,505-510',
};
const selectedCodexField = 'detection.apps.codex.detected';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const documentBinding = Object.freeze({
  sampleId: DOCUMENTS,
  version: documentFinder.version,
  sourceDigest: digest(documentFinder.source),
  fixtureDigest: digest(readFileSync(join(__dirname, 'kapi-yalitim.py'))),
  tool: 'belge_ara',
});
let documentGateId;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function openAgenticSource() {
  if (!chained) fail(404, 'Bu örnek bu kopyada bulunmuyor.');
  const { createChainedSession, dispatchChainedEvent } = chained;
  const { session, ...initial } = createChainedSession();
  let current = initial;
  function send(type, payload) {
    current = dispatchChainedEvent(session, {
      eventId: type,
      parent: current.receipt,
      surfaceId: current.state.surfaceId,
      type,
      payload,
    });
    if (!current.ok) fail(409, 'Agentic OS örneğinin adım bağlantısı doğrulanamadı. Örneği yeniden incele.');
    return current.output;
  }
  const examination = send('EXAMINE', { kind: 'folder', measuredOrder: 'jsOrdinalAsc' });
  return { send, examination, binding: { sampleId: AGENTIC, sourceScope: examination.pendingCandidate } };
}

function preview(sampleId) {
  if (sampleId === AGENTIC) {
    const { binding } = openAgenticSource();
    const { acceptedCount, totalSkippedCount } = binding.sourceScope;
    return {
      title: 'Agentic OS',
      overview: 'Birden fazla yapay zekâ aracı kullanan kişiler, Agentic OS ile bu araçları tek bir panelden görüp ayarlayabilir. Örneğin, Codex bulunduğunda kurulum ekranı onu gösterir ve başlangıç seçimini buna göre hazırlar.',
      scope: `Agentic OS 3.0.0 için sabitlenmiş kısmi örnek. Örnek kapsam kaydında ${acceptedCount} dosya yer alır, ${totalSkippedCount} dosya kapsam dışıdır. Dosya adları önceden belirlenmiş kaynak referanslarıdır. Burada yalnızca Codex bilgisinin kurulum ekranına etkisini denersin.`,
      module: {
        title: 'Codex durumunu kurulumda göster',
        description: 'Codex için gelen “bulundu” bilgisini okur. Kurulumda hangi kartın ve başlangıç seçiminin görüneceğini belirler.',
      },
      evidence: [
        { title: 'Araç taramasının çıktısı', ref: 'scripts/aggregate.ts:3348,4074,4089', description: 'Tarama, bulduğu araçların durumunu bir araya getirip durum dosyasına yazar. Denemede bu tarama yerine senin seçimin girer.' },
        { title: 'Codex bilgisinin kaydı', ref: agenticRefs.record, description: 'Sabit örnek kayıtta Codex için bulundu veya bulunamadı bilgisi yer alır.' },
        { title: 'Verinin uygulamaya girişi', ref: agenticRefs.reader, description: 'Uygulama, yerel sunucudan gelen son durum kaydını okur.' },
        { title: 'Kurulum ekranındaki kart ve etiket', ref: agenticRefs.screen, description: 'Kurulum ekranı, araç için gelen duruma göre göstereceği kartı ve etiketi belirler.' },
        { title: 'Codex’in başlangıç seçimi', ref: agenticRefs.initialChoice, description: 'Kurulum açılırken bulunan araçlar için başlangıç ayarları hazırlanır. Codex bulunduğunda seçim açık başlar. Bulunamadığında seçim kapalı başlar.' },
      ],
      flow: [
        { title: 'Codex durumu oluşur', detail: 'Agentic OS çalışırken araç taramasının ürettiği bilgi durum kaydına yazılır. Bu denemede “Codex bulundu” bilgisini sen seçersin.' },
        { title: 'Durum ekrana ulaşır', detail: 'Yerel sunucu durum kaydını kurulum ekranına verir. Kurulum ekranı kayıttaki “Codex bulundu mu?” değerini kullanır.' },
        { title: 'Kurulum ekranı değişir', detail: 'Bu tek araçlı örnekte Codex bulunduysa kartı görünür ve başlangıç seçimi açık olur. Önceki adım “bulunamadı” gönderirse tarama ekranı, araç bulunamadığını bildirir.' },
      ],
      defaultInput: { codexDetected: false },
      mode: agenticMode,
      binding,
    };
  }
  if (sampleId === DOCUMENTS) {
    return {
      title: 'Belge Bulucu',
      overview: 'Evraklarını dosya adına göre bulmak isteyen kişiler için bir arama aracı. Örneğin “.pdf” yazınca adında bu ifade geçen belgeler bir listeye gelir.',
      scope: 'Yalıtılmış örnek klasördeki dört dosya adı aranır. Sana ait dosyalar bu klasöre açılmaz. Aracın ağ bağlantısı yalıtım tarafından engellenir.',
      module: {
        title: 'Belge adında ara',
        description: 'Arama ifadesini örnek dosya adlarıyla karşılaştırır. Kaç adın eşleştiğini ve eşleşen adları döndürür.',
      },
      evidence: [
        { title: 'Arama kuralı ve aracın cevabı', ref: 'kapi-ornek.cjs:20-34', description: 'Aranan ifadeyi dosya adları içinde bulur. Sayıyı ve dosya adlarını tek cevapta hazırlar.' },
        { title: 'Denemede kullanılan dosyalar', ref: 'kapi-yalitim.py:136-154', description: 'Dört hazır örnek yalıtılmış klasöre salt okunur olarak eklenir.' },
        { title: 'Cevabın ekrana ulaşması', ref: 'kapi-akis.cjs:275-292', description: 'Yerel çalıştırıcı, sınırları doğrulanan aramanın metin çıktısını ekrana döndürür.' },
      ],
      flow: [
        { title: 'Bir ifade yazarsın', detail: 'Çalıştır düğmesi, yazdığın ifadeyi Belge Bulucu’nun “Belge ara” işine gönderir.' },
        { title: 'Belge Bulucu eşleşmeleri sayar', detail: 'Örnek klasörde her dosyanın adına bakar. Yazdığın ifadeyi içeren adları sıralar ve sayısını çıkarır.' },
        { title: 'Sonuç burada görünür', detail: 'Laboratuvar aracın cevabındaki sayıyı ve eşleşen adları gösterir. Farklı bir ifade girince liste yeniden hesaplanır.' },
      ],
      defaultInput: { query: '.pdf' },
      mode: documentMode,
      binding: { ...documentBinding },
    };
  }
  fail(404, 'Bu örnek bulunamadı.');
}

function requireBinding(preview, expected) {
  if (!isDeepStrictEqual(preview?.binding, expected)) {
    fail(409, 'Deneme için onaylanan kaynak kapsamı doğrulanamadı. Örneği yeniden incele ve onayla.');
  }
}

function requireInput(input, field) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, field) || Object.keys(input).length !== 1) {
    fail(400, 'Bu deneme için ekrandaki örnek girdiyi kullan.');
  }
  return input[field];
}

function runAgentic(input, context) {
  const codexDetected = requireInput(input, 'codexDetected');
  if (typeof codexDetected !== 'boolean') fail(400, 'Codex için “Bulundu” veya “Bulunamadı” seç.');
  const { send, examination, binding } = openAgenticSource();
  requireBinding(context?.preview, binding);
  const approved = send('CONFIRM', { candidateId: examination.candidateId, explicitPartialConfirm: true });
  send('OPEN_CARD');
  const { selection } = send('SELECT_FIELD');
  const { evidence } = send('OPEN_EVIDENCE');
  send('CLOSE_EVIDENCE');
  const flow = send('OPEN_FLOW');
  const experiment = send('OPEN_EXPERIMENT');
  send('EDIT_DRAFT', { codexDetected });
  const result = send('RUN');
  const { runRecord } = result;
  const { provenance } = runRecord;
  if (!isDeepStrictEqual(approved.activeSelection, binding.sourceScope) ||
      !isDeepStrictEqual(provenance.sourceScope, approved.activeSelection) ||
      !isDeepStrictEqual(provenance.selection, flow.preservedSelection) ||
      !isDeepStrictEqual(provenance, experiment.provenance) ||
      provenance.approvalId !== examination.candidateId ||
      provenance.selection.selectedDataField !== selectedCodexField ||
      selection.selectedDataField !== selectedCodexField ||
      evidence.ref !== agenticRefs.record || !evidence.supportedDataFields.includes(selectedCodexField) ||
      runRecord.inputs.codexDetected !== codexDetected || !runRecord.isSynthetic ||
      result.syntheticEvalCount !== 1 || result.liveCallCount !== 0) {
    fail(409, 'Kurulum sonucunun onaylanan örnekten geldiği doğrulanamadı.');
  }

  const detected = runRecord.codexDetected;
  const badge = runRecord.codexCardBadge?.split(' · ')[0];
  return {
    summary: detected ? `Kurulum ekranında Codex kartı “${badge}” etiketiyle görünür.` : runRecord.outputSummary,
    details: [
      `Kurulum ekranına gelen sonuç “${detected ? 'araç bulundu' : 'araç bulunamadı'}”.`,
      `Codex için hazırlanan başlangıç seçimi ${runRecord.initialCodexEnabled ? 'açık' : 'kapalı'}.`,
      'Burada örnek veri kullanılır. Bilgisayarında araç taraması yapılmaz.',
    ],
    mode: agenticMode,
    usage: 'Agentic OS bu bilgiyi, kurulumda hangi araçları göstereceğini ve başlangıçta hangi seçimleri açacağını belirlemek için kullanır.',
  };
}

async function openDocumentGate(signal) {
  const listing = await gateFlow({ action: 'inspect', preset: 'v1' }, signal);
  if (listing.status !== 'pending' || listing.version !== documentBinding.version || !listing.id) {
    fail(503, 'Belge Bulucu için yalıtılmış ortam açılamadı. Deneme sonucu alınmadı.');
  }
  documentGateId = listing.id;
  return listing.id;
}

async function searchDocumentGate(query, signal) {
  const run = id => gateFlow({ action: 'run', id, tool: documentBinding.tool, input: query, approve: true }, signal);
  const id = documentGateId ?? await openDocumentGate(signal);
  try {
    return await run(id);
  } catch (error) {
    // Kapı keeps a bounded session list. Replace an expired entry only when needed.
    if (error.status !== 404) throw error;
    return run(await openDocumentGate(signal));
  }
}

async function runDocuments(input, context) {
  const value = requireInput(input, 'query');
  if (typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/i.test(value) || !value.trim()) {
    fail(400, 'Aramak için 1 ile 120 karakter arasında bir kelime veya .pdf gibi bir ifade yaz.');
  }
  requireBinding(context?.preview, documentBinding);
  const query = value.trim();
  const result = await searchDocumentGate(query, context?.signal);
  if (!result.ok || result.status !== 'worked' || typeof result.output !== 'string') {
    fail(503, 'Belge Bulucu’nun yalıtılmış çalışması doğrulanamadı. Deneme sonucu alınmadı.');
  }
  const [summary, ...files] = result.output.split('\n');
  return {
    summary,
    details: [
      ...(files.length ? files : ['Örnek dosya adlarından hiçbiri bu ifadeyle eşleşmedi.']),
      ...result.blocked,
    ],
    mode: documentMode,
    usage: 'Laboratuvar, Belge Bulucu’nun döndürdüğü bu listeyi sonuç alanında gösterir. Böylece hangi belgelerin aramana uyduğunu görürsün.',
  };
}

async function execute(sampleId, input, context) {
  if (sampleId === AGENTIC) return runAgentic(input, context);
  if (sampleId === DOCUMENTS) return runDocuments(input, context);
  fail(404, 'Bu örnek bulunamadı.');
}

module.exports = { samples, preview, execute };
