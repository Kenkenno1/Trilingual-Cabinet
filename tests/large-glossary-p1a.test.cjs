const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', '三語書房 v2.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/\/\/ P1a large-text glossary core: pure functions only\.([\s\S]*?)\/\/ End P1a large-text glossary core\./);
assert.ok(match, 'P1a core block must exist in the HTML file');

const exportedNames = [
  'LARGE_TEXT_SOFT_TOKEN_LIMIT',
  'LARGE_TEXT_HARD_TOKEN_LIMIT',
  'LARGE_TEXT_MAX_CHUNKS',
  'LARGE_TEXT_CHUNK_MAX_TOKENS',
  'LARGE_TEXT_OVERLAP_MAX_TOKENS',
  'LARGE_TEXT_CANDIDATES_PER_CHUNK',
  'LARGE_TEXT_FINAL_CANDIDATES',
  'estimateLargeTextTokens',
  'getLargeTextPreflight',
  'chunkLargeGlossaryText',
  'planLargeGlossaryText',
  'normalizeLargeGlossaryTerm',
  'mergeLargeGlossaryCandidates',
  'rankLargeGlossaryCandidates',
  'excludeExistingLargeGlossaryCandidates',
  'selectLargeGlossaryCandidates',
];
const context = vm.createContext({ console });
vm.runInContext(`${match[0]}\nglobalThis.P1A = { ${exportedNames.join(', ')} };`, context);
const core = context.P1A;

function assertChunkPlan(text, chunks){
  assert.ok(chunks.length > 0, 'non-empty input must produce chunks');
  assert.equal(chunks[0].startOffset, 0);
  assert.equal(chunks[0].primaryStartOffset, 0);
  let rebuilt = '';
  for (let i = 0; i < chunks.length; i++){
    const chunk = chunks[i];
    assert.equal(chunk.chunkId, i);
    assert.ok(chunk.text.length > 0, 'chunks must not be empty');
    assert.ok(!/[\ud800-\udbff]$/.test(chunk.text), 'chunk must not end with an unmatched high surrogate');
    assert.ok(!/^[\udc00-\udfff]/.test(chunk.text), 'chunk must not start with an unmatched low surrogate');
    assert.equal(chunk.text, text.slice(chunk.startOffset, chunk.endOffset));
    assert.ok(chunk.startOffset <= chunk.primaryStartOffset);
    assert.ok(chunk.primaryStartOffset < chunk.endOffset);
    assert.ok(chunk.estimatedTokens <= core.LARGE_TEXT_CHUNK_MAX_TOKENS);
    if (i > 0){
      assert.equal(chunk.primaryStartOffset, chunks[i - 1].endOffset);
      assert.ok(chunk.startOffset >= chunks[i - 1].primaryStartOffset);
    }
    rebuilt += chunk.text.slice(chunk.primaryStartOffset - chunk.startOffset);
  }
  assert.equal(rebuilt, text, 'non-overlap primary spans must rebuild the source exactly');
}

assert.equal(core.estimateLargeTextTokens(''), 0);
assert.equal(core.estimateLargeTextTokens('abcd'), 1);
assert.equal(core.estimateLargeTextTokens('abcde'), 2);
assert.equal(core.estimateLargeTextTokens(' \n\t'), 0);
assert.equal(core.estimateLargeTextTokens('中文'), 2);
assert.equal(core.estimateLargeTextTokens('A中'), 2);
assert.equal(core.estimateLargeTextTokens('😀'), 1);

assert.deepEqual(
  JSON.parse(JSON.stringify(core.getLargeTextPreflight('短文'))),
  { charCount: 2, estimatedTokens: 2, route: 'short', warning: null, reason: null },
);
assert.equal(core.getLargeTextPreflight('a'.repeat(8001)).route, 'chunked');
assert.equal(core.getLargeTextPreflight('中'.repeat(60001)).warning, 'large-input');
assert.equal(core.getLargeTextPreflight('中'.repeat(80001)).reason, 'token-limit');
assert.equal(core.getLargeTextPreflight('a'.repeat(320001)).reason, 'absolute-char-limit');

const cjkText = '中'.repeat(7000);
const cjkChunks = core.chunkLargeGlossaryText(cjkText);
assert.equal(cjkChunks.length, 2);
assertChunkPlan(cjkText, cjkChunks);

const latinText = 'abcd '.repeat(7500);
assertChunkPlan(latinText, core.chunkLargeGlossaryText(latinText));

const emojiText = `${'😀'.repeat(3100)}段落${'🚀'.repeat(3100)}`;
const emojiChunks = core.chunkLargeGlossaryText(emojiText);
assertChunkPlan(emojiText, emojiChunks);

let randomSeed = 0x51a7c0de;
function nextRandom(){
  randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0;
  return randomSeed / 0x100000000;
}
const randomAlphabet = ['中', '文', 'a', 'B', ' ', '\n', '。', '！', '😀'];
for (let fixture = 0; fixture < 40; fixture++){
  const length = 200 + Math.floor(nextRandom() * 12000);
  let text = '';
  for (let i = 0; i < length; i++) text += randomAlphabet[Math.floor(nextRandom() * randomAlphabet.length)];
  assertChunkPlan(text, core.chunkLargeGlossaryText(text));
}

const blankLinePriorityText = `${'中'.repeat(2500)}\n\n${'中'.repeat(700)}。${'中'.repeat(3000)}`;
const blankLinePriorityChunks = core.chunkLargeGlossaryText(blankLinePriorityText);
assert.equal(blankLinePriorityChunks[0].endOffset, 2502, 'blank line wins over a nearer sentence boundary');
assertChunkPlan(blankLinePriorityText, blankLinePriorityChunks);

const sentenceBoundaryText = `${'中'.repeat(2900)}。${'中'.repeat(3500)}`;
const sentenceBoundaryChunks = core.chunkLargeGlossaryText(sentenceBoundaryText);
assert.equal(sentenceBoundaryChunks[0].endOffset, 2901);
assertChunkPlan(sentenceBoundaryText, sentenceBoundaryChunks);

const overlapText = `${'中'.repeat(3990)}\n\n${'文'.repeat(3990)}\n\n${'末'.repeat(100)}`;
const overlapChunks = core.chunkLargeGlossaryText(overlapText);
assertChunkPlan(overlapText, overlapChunks);
assert.ok(overlapChunks.length >= 3);
const secondOverlap = overlapText.slice(overlapChunks[1].startOffset, overlapChunks[1].primaryStartOffset);
assert.ok(core.estimateLargeTextTokens(secondOverlap) <= 10, 'overlap shrinks when the primary span approaches 4000 tokens');

const sentenceOverlapText = Array.from({ length: 40 }, (_, i) => `${i}${'句'.repeat(120)}。`).join('');
const sentenceOverlapChunks = core.chunkLargeGlossaryText(sentenceOverlapText);
assertChunkPlan(sentenceOverlapText, sentenceOverlapChunks);
for (const chunk of sentenceOverlapChunks.slice(1)){
  const overlap = sentenceOverlapText.slice(chunk.startOffset, chunk.primaryStartOffset);
  assert.ok(core.estimateLargeTextTokens(overlap) <= core.LARGE_TEXT_OVERLAP_MAX_TOKENS);
  assert.ok((overlap.match(/[。！？!?．.]/g) || []).length <= 2, 'overlap contains at most two complete sentences');
}

const softBandText = '中'.repeat(65000);
const softBandInitial = core.getLargeTextPreflight(softBandText);
assert.equal(softBandInitial.route, 'chunked');
assert.equal(softBandInitial.warning, 'large-input');
const softBandPlan = core.planLargeGlossaryText(softBandText);
assert.ok(softBandPlan.chunks.length > core.LARGE_TEXT_MAX_CHUNKS);
assert.equal(softBandPlan.preflight.route, 'reject');
assert.equal(softBandPlan.preflight.reason, 'chunk-limit');
assertChunkPlan(softBandText, softBandPlan.chunks);

assert.equal(core.normalizeLargeGlossaryTerm('  ＡＩ　 Model\nName  '), 'ai model name');

const longField = '長'.repeat(61);
const chunkResults = [
  {
    chunkId: 0,
    startOffset: 100,
    terms: [
      { source: 'ＡＩ', translation: '人工智慧', category: 'technical term', confidence: 0.7, firstOffset: 120, occurrences: 99 },
      { source: 'AI', translation: '人工智能', category: 'brand', confidence: 0.8, firstOffset: 140, occurrences: 1 },
      { source: '', translation: '空值' },
      { source: { term: 'object' }, translation: '不應採用' },
      { source: longField, translation: '過長' },
      ...Array.from({ length: 10 }, (_, i) => ({ source: `term-${i}`, translation: `詞-${i}`, category: 'other jargon', confidence: 0.2 })),
    ],
  },
  {
    chunkId: 1,
    startOffset: 4000,
    terms: [
      { source: 'ai', translation: 'AI', category: 'proper noun', confidence: 1.5, firstOffset: 4010, occurrences: 42 },
      { source: 'second', translation: '第二', category: 'unknown', confidence: -1 },
    ],
  },
  {
    chunkId: 99,
    terms: [{ source: 'failed chunk', translation: '不應採用' }],
  },
];
const merged = core.mergeLargeGlossaryCandidates(chunkResults, [0, 1]);
assert.equal(core.mergeLargeGlossaryCandidates(chunkResults, []).length, 0);
const ai = merged.find(item => item.key === 'ai');
assert.ok(ai);
assert.deepEqual(Array.from(ai.chunkIds), [0, 1]);
assert.equal(ai.distinctChunkCount, 2);
assert.equal(ai.categoryPriority, 3);
assert.equal(ai.confidence, 1);
assert.equal(ai.firstOffset, 120);
assert.equal(ai.source, 'ＡＩ');
assert.ok(!Object.hasOwn(ai, 'totalOccurrences'), 'model-reported occurrences must not enter merged data');
assert.ok(!merged.some(item => item.key === core.normalizeLargeGlossaryTerm(longField)));
assert.ok(!merged.some(item => item.source === '[object Object]'));
assert.ok(!merged.some(item => item.key === 'failed chunk'));
assert.equal(merged.filter(item => item.chunkIds.includes(0)).length, core.LARGE_TEXT_CANDIDATES_PER_CHUNK);

const deterministicA = core.mergeLargeGlossaryCandidates([
  { chunkId: 0, terms: [{ source: 'ＡＢＣ', translation: '乙', firstOffset: 10 }] },
  { chunkId: 1, terms: [{ source: 'ABC', translation: '甲', firstOffset: 10 }] },
]);
const deterministicB = core.mergeLargeGlossaryCandidates([
  { chunkId: 1, terms: [{ source: 'ABC', translation: '甲', firstOffset: 10 }] },
  { chunkId: 0, terms: [{ source: 'ＡＢＣ', translation: '乙', firstOffset: 10 }] },
]);
assert.equal(deterministicA[0].source, deterministicB[0].source);
assert.equal(deterministicA[0].translation, deterministicB[0].translation);

const ranked = core.rankLargeGlossaryCandidates([
  { key: 'z', distinctChunkCount: 1, categoryPriority: 4, confidence: 1, firstOffset: 0, chunkIds: [0] },
  { key: 'a', distinctChunkCount: 2, categoryPriority: 0, confidence: 0, firstOffset: 50, chunkIds: [0, 1] },
  { key: 'b', distinctChunkCount: 1, categoryPriority: 4, confidence: 1, firstOffset: 0, chunkIds: [2] },
]);
assert.deepEqual(Array.from(ranked, item => item.key), ['a', 'b', 'z']);

const filtered = core.excludeExistingLargeGlossaryCandidates(merged, [{ src: 'ＡＩ' }]);
assert.ok(!filtered.some(item => item.key === 'ai'));

const selectionPool = [
  { key: 'shared', distinctChunkCount: 2, categoryPriority: 4, confidence: 1, firstOffset: 0, chunkIds: [0, 1] },
  { key: 'chunk-0', distinctChunkCount: 1, categoryPriority: 3, confidence: 1, firstOffset: 1, chunkIds: [0] },
  { key: 'chunk-1', distinctChunkCount: 1, categoryPriority: 3, confidence: 1, firstOffset: 2, chunkIds: [1] },
  { key: 'chunk-2', distinctChunkCount: 1, categoryPriority: 2, confidence: 1, firstOffset: 3, chunkIds: [2] },
];
const selected = core.selectLargeGlossaryCandidates(selectionPool, [0, 1, 2], 3);
assert.deepEqual(Array.from(selected, item => item.key), ['shared', 'chunk-2', 'chunk-0']);
assert.equal(
  core.selectLargeGlossaryCandidates(selectionPool, [], core.LARGE_TEXT_FINAL_CANDIDATES).length,
  0,
  'non-empty candidates with no successful chunks must return no selections',
);

const largeSelectionPool = Array.from({ length: 40 }, (_, i) => ({
  key: `key-${String(i).padStart(2, '0')}`,
  distinctChunkCount: 1,
  categoryPriority: 0,
  confidence: 0,
  firstOffset: i,
  chunkIds: [i % 20],
}));
assert.equal(
  core.selectLargeGlossaryCandidates(largeSelectionPool, Array.from({ length: 20 }, (_, i) => i)).length,
  core.LARGE_TEXT_FINAL_CANDIDATES,
);

console.log(JSON.stringify({
  status: 'P1A_DETERMINISTIC_QA_PASSED',
  tests: 46,
  propertyFixtures: 40,
  softBandChunks: softBandPlan.chunks.length,
  cjkChunks: cjkChunks.length,
  overlapChunks: overlapChunks.length,
}));
