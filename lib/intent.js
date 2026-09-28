'use strict';
// Rule-based classification. Deterministic, free, instant on tens of thousands of phrases.
// Order matters: the first matching rule wins.
const RULES = [
  ['jobs', /\b(jobs?|vacanc\w*|hiring|salary|careers?|work from home|recruitment)\b/],
  ['business', /\b(franchis\w*|distributor|dealership|licen[cs]e|business|investment|become a|start(ing)? (a|an|your)\b)/],
  ['training', /\b(teacher training|train\w*|certification|course|courses|diploma|instructor|workshop)\b/],
  ['price', /\b(fees?|price|prices|cost|charges?|rates?|how much|cheap|affordable|discount|offers?)\b/],
  ['product', /\b(buy|purchase|order|kits?|boards?|beads?|frame|slate|toys?|shop|store|amazon|flipkart|set)\b/],
  ['app', /\b(apps?|apk|download|software|website|games?|simulator|tools?|ai|calculator|play store|ios|android)\b/],
  ['compare', /\b(best|top|vs|versus|reviews?|alternatives?|compare|comparison|better)\b/],
  ['resource', /\b(worksheets?|pdf|printable|exercises?|questions?|books?|syllabus|charts?|formulas?|tricks?|tips|sheets?|practice|videos?|youtube|tutorials?)\b/],
  ['exam', /\b(competitions?|olympiad|exams?|contests?|tests?|results?|levels?|certificate)\b/],
  ['local', /\b(near me|nearby|near|classes|class|centres?|centers?|institutes?|academy|coaching|tuition|school|address|contact|timings?|admissions?|batch(es)?)\b/],
  ['language', /\b(tamil|hindi|telugu|kannada|malayalam|marathi|bengali|gujarati|urdu|punjabi|kya hai|kaise|seekhe|sikhe)\b/],
  ['audience', /\b(kids?|children|child|adults?|beginners?|preschool|toddlers?|year old|years old|grade \d|std \d|age)\b/],
  ['learn', /\b(how|what|why|when|where|who|meaning|definition|learn|history|parts|steps|benefits|uses?|works?|examples?|types)\b/],
];

const META = {
  local: { label: 'Find a provider', who: 'People looking for a provider near them', angle: 'Sellers are local providers. Find them on Maps and pitch them.' },
  app: { label: 'App / tool', who: 'People looking for an app or software', angle: 'Check competing apps. Differentiate on simplicity, language or price.' },
  training: { label: 'Training / teachers', who: 'Teachers and people wanting to become one', angle: 'Sell courses, kits or software to people starting to teach.' },
  business: { label: 'Franchise / business', who: 'People wanting to start or license a business', angle: 'Sell starter kits, software or a partner programme.' },
  resource: { label: 'Free resources', who: 'Parents, students and teachers wanting material', angle: 'A free tool or worksheet draws the right audience, then follow up.' },
  price: { label: 'Fees / price', who: 'Buyers comparing cost', angle: 'Close to a decision. Clear, simple pricing wins.' },
  compare: { label: 'Compare / best', who: 'Buyers comparing options', angle: 'Reviews and proof matter most here.' },
  exam: { label: 'Exams / competitions', who: 'Students and parents preparing for tests', angle: 'Practice tools sell well before exam season.' },
  product: { label: 'Physical product', who: 'People ready to buy a product', angle: 'Kit makers and shops sell here. Also a way to reach many teachers through suppliers.' },
  language: { label: 'Language', who: 'People wanting it in their own language', angle: 'Local-language demand is often under-served. Build or market in that language.' },
  audience: { label: 'By audience / age', who: 'Parents and learners of a specific group', angle: 'Shows who the real buyer is. Use their words in your pitch.' },
  learn: { label: 'Learn / how-to', who: 'Curious beginners', angle: 'Early stage. Content brings them in, a product converts later.' },
  jobs: { label: 'Jobs', who: 'Job seekers', angle: 'Low buying intent for most products.' },
  other: { label: 'Other', who: 'Mixed', angle: 'Review manually.' },
};

function intentOf(phrase) {
  for (const [name, re] of RULES) if (re.test(phrase)) return name;
  return 'other';
}

const STOP = new Set(('a an the of in for to and or is are was be my me i you your with on at by from as it this that these those can do does did how what why when where who which ' +
  'get make use using vs versus into about than then there their so if not no yes am we our us up out over under best top ' +
  'near nearby classes class online free').split(' '));
// words that follow "in"/"near"/a provider word but are not places
const NOT_PLACE = new Set(('me my you your us home school schools india indian tamil hindi english telugu kannada malayalam marathi bengali gujarati urdu punjabi ' +
  'online offline free fees fee price cost kids kid children child adults adult beginners beginner students student parents parent teacher teachers training ' +
  'course courses class classes center centre centers centres institute academy app apps pdf video videos ' +
  'near nearby for with and the a an of to is at by from this that these those what how why when where which who ' +
  'level levels exam exams competition competitions certificate certification syllabus worksheet worksheets book books ' +
  'timing timings address contact number phone review reviews fees admission admissions franchise franchisee jobs job ' +
  'small big new old good best top cheap low high per month year day week hour hours minute minutes ' +
  'maths math mathematics vedic brain mental arithmetic learning learn tuition coaching batch batches ' +
  'india\'s') .split(' '));

const ANCHOR = /\b(?:in|near|at|around)\s+([a-z][a-z .'-]{2,28})$|\b(?:classes|class|centre|centres|center|centers|institute|academy|coaching|tuition|training|teacher|courses?)\s+([a-z][a-z.'-]{2,20}(?: [a-z][a-z.'-]{2,14})?)$/;

// A place name mentioned in the phrase ("abacus classes in salem" -> "salem"). Heuristic; may miss or misfire.
function placeOf(phrase) {
  const m = phrase.match(ANCHOR);
  if (!m) return '';
  let cand = (m[1] || m[2] || '').trim();
  if (!cand) return '';
  const toks = cand.split(' ');
  if (NOT_PLACE.has(toks[0])) return '';
  const kept = [];
  for (const t of toks) { if (NOT_PLACE.has(t)) break; kept.push(t); }
  cand = kept.join(' ');
  if (cand.length < 3) return '';
  return cand;
}

const tokens = (s) => s.split(/[^a-z0-9஀-௿ऀ-ॿ]+/i).filter(Boolean);

// Unigram + bigram "topic terms" for the filter chips, excluding the seed itself.
function termsOf(phrase, seedTokens) {
  const out = new Set();
  const toks = tokens(phrase);
  let run = [];
  const flush = () => {
    for (let i = 0; i < run.length; i++) {
      const t = run[i];
      if (t.length >= 3 && !STOP.has(t)) out.add(t);
      if (i + 1 < run.length) {
        const b = run[i + 1];
        if (!(STOP.has(t) && STOP.has(b)) || (t === 'near' && b === 'me')) out.add(t + ' ' + b);
      }
    }
    run = [];
  };
  for (const t of toks) { if (seedTokens.has(t)) flush(); else run.push(t); }
  flush();
  // "near me" and "for kids" style bigrams built from stop words are useful, keep the common ones
  return out;
}

module.exports = { intentOf, placeOf, termsOf, tokens, META, STOP };
