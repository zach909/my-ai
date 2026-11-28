// Good-knowledge / bad-knowledge rules. Hand-written, inspectable, deterministic. Three uses:
//  classifyText(): label a training passage     classifyCode(): label a code sample     gate(): accept/refuse a user request
// Principle: UNDERSTANDING is allowed, APPROVING or PERFORMING is not. A passage that describes harm in an
// educational / defensive / historical frame is kept as knowledge ("understand-only"); a passage that instructs harm
// is never a positive training example. Rules are regexes + a context test, so every decision can be explained.

export const CLASSES = ['GOOD', 'UNSUPPORTED_CLAIM', 'DECEPTIVE', 'MALICIOUS_INSTRUCTION', 'HARMFUL', 'DANGEROUS_NO_CONTEXT'];
// What training may do with each class.
export const ACTION = {
  GOOD: 'train-positive',
  UNSUPPORTED_CLAIM: 'quarantine',            // may be used only as a labelled "claim, unverified" example
  DECEPTIVE: 'train-negative-only',
  MALICIOUS_INSTRUCTION: 'train-negative-only',
  HARMFUL: 'train-negative-only',
  DANGEROUS_NO_CONTEXT: 'quarantine',
};

const SAFETY_CONTEXT = /\b(to (defend|protect|prevent|detect|mitigate|avoid)|defen[cs]e|defensive|protect(ion)? against|how to (detect|spot|recogni[sz]e|avoid|prevent|stay safe)|warning|danger(ous)? (because|since)|never (mix|combine|do)|do not (mix|combine|attempt)|safety|first aid|history of|historically|in (this )?(course|lecture|textbook)|security research|authori[sz]ed|penetration test(ing)? (with|under)|ctf|educational|for education|explains? (why|how)|is (illegal|a crime|unethical)|report(ing)? (it|this)|awareness)\b/i;
// [class, regex, reason]. A rule fires only on text that INSTRUCTS or ENCOURAGES (imperative / "how to" / "step"), see needsInstruct.
const HARM_RULES = [
  ['MALICIOUS_INSTRUCTION', /\b(write|create|build|make|code|develop|deploy|spread|install)\b[^.\n]{0,40}\b(ransomware|keylogger|botnet|rootkit|computer (virus|worm)|trojan|malware|spyware|stalkerware|credential stealer)\b/i, 'asks to create or deploy malware'],
  ['MALICIOUS_INSTRUCTION', /\b(ddos|denial[- ]of[- ]service)\b[^.\n]{0,40}\b(attack|launch|take down|against)\b[^.\n]{0,30}\b(site|server|website|target|victim)/i, 'instructs a denial-of-service attack'],
  ['MALICIOUS_INSTRUCTION', /\b(hack|break|get) into (someone|somebody|my (ex|neighbou?r|boss)|another person)'?s? (account|phone|email|wifi|computer)/i, 'instructs unauthorised access to a person\'s account'],
  ['MALICIOUS_INSTRUCTION', /\b(steal|harvest|exfiltrate|dump)\b[^.\n]{0,30}\b(passwords?|credentials|credit card|cookies|session tokens?)\b[^.\n]{0,30}\b(from (users|victims|people|the target)|without (their )?(knowledge|consent))/i, 'credential theft'],
  ['DECEPTIVE', /\b(write|create|make|design|draft|send)\b[^.\n]{0,40}\b(phishing|fake (invoice|id|passport|review|reviews|news|certificate|diploma|prescription)|scam (email|text|call|script)|forged)\b/i, 'asks for deceptive material'],
  ['DECEPTIVE', /\bimpersonat(e|ing)\b[^.\n]{0,40}\b(bank|police|government|doctor|support|employee|relative|official)\b/i, 'impersonation to deceive'],
  ['DECEPTIVE', /\b(trick|convince|manipulate|pressure|groom)\b[^.\n]{0,40}\b(elderly|old people|children|kids|a (minor|victim)|vulnerable)\b[^.\n]{0,40}\b(into|to) (giving|sending|paying|handing|sharing|keeping)/i, 'manipulating a vulnerable person'],
  ['HARMFUL', /\b(how (do i|to|can i)|steps? (to|for)|instructions? (for|to)|ways? to|best way to)\b[^.\n]{0,30}\b(kill|poison|hurt|injure|stab|strangle|torture|murder)\b[^.\n]{0,30}\b(someone|somebody|a person|my (wife|husband|boss|ex|neighbou?r|roommate|mother|father|kid|child)|him|her|them)\b/i, 'violence against a person'],
  ['HARMFUL', /\b(in order to|so (that )?(he|she|they)|to) (hurt|harm|injure|kill|poison|burn|maim)\b[^.\n]{0,15}\b(him|her|them|someone|somebody|people|my \w+)\b/i, 'stated intent to harm a person'],
  ['HARMFUL', /\b(how (do i|to|can i)|steps? (to|for)|instructions? (for|to)|best way to)\b[^.\n]{0,25}\b(kill myself|commit suicide|end my life|self[- ]harm|cut myself)\b/i, 'self-harm instruction'],
  ['HARMFUL', /\byou should (kill yourself|hurt yourself|starve yourself|stop taking your (medication|insulin|medicine))\b/i, 'encourages self-harm or stopping medicine'],
  ['HARMFUL', /\b(synthesi[sz]e|manufacture|cook|produce|make|build|assemble)\b[^.\n]{0,40}\b(nerve agent|sarin|vx gas|mustard gas|chemical weapon|bioweapon|anthrax|pipe bomb|explosive device|nail bomb|improvised explosive|methamphetamine|fentanyl|untraceable (gun|firearm))\b/i, 'weapon or hard-drug synthesis'],
];
const DANGER_TOPIC = /\b(bleach|ammonia|chlorine gas|thermite|nitroglycerin|detonat\w+|lethal dose|overdose|carbon monoxide|toxic gas|high[- ]voltage|mains electricity|lock ?picking|bypass(ing)? (a )?(safety|interlock|alarm))\b/i;
const INSTRUCT = /\b(step \d|follow these|you (need|will need|can|should|must)|how to|instructions?|mix(ing)? (it|them|the)|pour|combine (it|them|the))\b/i;
const UNSUPPORTED = [
  [/\b(miracle|secret|one weird) (cure|trick|remedy)\b/i, 'miracle-cure language'],
  [/\b(doctors|scientists|experts) (hate|don'?t want you to know|are hiding|are lying)\b/i, 'conspiratorial appeal'],
  [/\b(guaranteed|100% (effective|safe|cure|proven)|always works|never fails|proven to (cure|heal|reverse))\b/i, 'absolute, unhedged claim'],
  [/\b(cures?|reverses?|eliminates?) (cancer|diabetes|autism|aids|hiv|alzheimer'?s|covid)\b/i, 'unsupported medical cure claim'],
  [/\b(everyone knows|it is obvious|obviously|clearly) (that )?[^.\n]{0,60}\b(is|are) (a hoax|fake|a lie|false)\b/i, 'assertion by appeal to obviousness'],
  [/\b(vaccines? cause autism|the earth is flat|5g (causes|spreads) (covid|cancer)|chemtrails (are|contain)|moon landing (was )?(fake|faked|hoax))\b/i, 'claim contradicted by strong evidence'],
];
const EVIDENCE_MARK = /\b(according to|et al\.?|\(\d{4}\)|doi:|arxiv:|study|trial|measured|observed|experiment|evidence|data (show|suggest)|we (found|show)|results (show|indicate)|p\s*[<=]\s*0?\.\d+|confidence interval|meta-analysis|peer[- ]review)/i;

export function classifyText(text) {
  const t = String(text), hits = [];
  const safe = SAFETY_CONTEXT.test(t);
  for (const [cls, re, why] of HARM_RULES) if (re.test(t)) hits.push({ cls, why });
  if (hits.length) {
    // understanding vs performing: a safety/educational frame that does NOT itself carry an imperative request keeps it as knowledge
    const imperative = /\b(how (do i|to|can i)|steps? (to|for)|give me|tell me how|show me how|help me|i want to|let'?s)\b/i.test(t);
    if (safe && !imperative) return { cls: 'GOOD', action: ACTION.GOOD, understandOnly: true, reasons: ['describes harm in a defensive/educational frame: ' + hits[0].why], hits };
    return { cls: hits[0].cls, action: ACTION[hits[0].cls], reasons: hits.map((h) => h.why), hits };
  }
  if (DANGER_TOPIC.test(t) && INSTRUCT.test(t) && !safe && !EVIDENCE_MARK.test(t)) return { cls: 'DANGEROUS_NO_CONTEXT', action: ACTION.DANGEROUS_NO_CONTEXT, reasons: ['hazard topic with procedure and no safety framing'] };
  const un = UNSUPPORTED.filter(([re]) => re.test(t));
  if (un.length && !EVIDENCE_MARK.test(t)) return { cls: 'UNSUPPORTED_CLAIM', action: ACTION.UNSUPPORTED_CLAIM, reasons: un.map((u) => u[1]) };
  return { cls: 'GOOD', action: ACTION.GOOD, reasons: [], understandOnly: false };
}

// ---- code ----
const CODE_MAL = [
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/\brm\s+-rf?\s+(--no-preserve-root\s+)?\/(\s|$|\*)/, 'recursive delete of root'],
  [/\/dev\/tcp\/[^\s]+\/\d+/, 'bash reverse shell'], [/\bnc(at)?\b[^\n]*\s-e\s+\/bin\/(ba)?sh/, 'netcat shell'],
  [/(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'pipes a download to a shell'],
  [/\b(exec|eval)\s*\(\s*(base64\.b64decode|atob|codecs\.decode)/, 'executes obfuscated payload'],
  [/\b(pynput|keyboard)\b[\s\S]{0,300}\b(listener|on_press|hook)\b[\s\S]{0,300}\b(post|send|smtp|requests\.)/i, 'keylogger exfiltrating input'],
  [/(\.encrypt\(|AES|Fernet)[\s\S]{0,400}(os\.walk|glob)[\s\S]{0,400}(ransom|bitcoin|decrypt your files|pay)/i, 'file-encrypting ransomware pattern'],
];
const CODE_UNSAFE = [
  [/\b(gets|strcpy|strcat|sprintf)\s*\(/, 'unbounded C string function'],
  [/\b(execute|query)\s*\(\s*(f["'][^\n]*\{|["'][^\n]*["']\s*(\+|%\s))/, 'SQL built by string concatenation or formatting'],
  [/\bos\.system\s*\(\s*[^)]*(input\(|argv|request\.)/, 'shell command built from user input'],
  [/\bpickle\.loads?\s*\(/, 'unpickling untrusted data'], [/\bverify\s*=\s*False\b/, 'TLS verification disabled'],
  [/(password|passwd|secret|api[_-]?key)\s*=\s*["'][^"']{6,}["']/i, 'hard-coded credential'],
];
export function classifyCode(src) {
  const mal = CODE_MAL.filter(([re]) => re.test(src)).map((x) => x[1]);
  if (mal.length) return { cls: 'MALICIOUS_INSTRUCTION', action: ACTION.MALICIOUS_INSTRUCTION, reasons: mal };
  const un = CODE_UNSAFE.filter(([re]) => re.test(src)).map((x) => x[1]);
  if (un.length) return { cls: 'DANGEROUS_NO_CONTEXT', action: 'quarantine', reasons: un, note: 'unsafe practice: usable only as a labelled "do not write this" example' };
  return { cls: 'GOOD', action: ACTION.GOOD, reasons: [] };
}

// ---- request gate: should the assistant do what is asked? ----
export function gate(request) {
  const r = classifyText(request);
  const refuse = ['MALICIOUS_INSTRUCTION', 'HARMFUL', 'DECEPTIVE'].includes(r.cls);
  return { allow: !refuse && r.cls !== 'DANGEROUS_NO_CONTEXT', cls: r.cls, reasons: r.reasons,
    response: refuse ? 'REFUSE: ' + r.reasons.join('; ') + '. Offer safe alternative: explain the concept, defence, or legal route.' : r.cls === 'DANGEROUS_NO_CONTEXT' ? 'ASK: hazard topic without a safety context - answer only with safety framing.' : 'ALLOW' };
}
