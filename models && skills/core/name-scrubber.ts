/**
 * Name scrubber: blanks company, brand and product names (and web addresses)
 * out of training text and puts something plain and generic in their place.
 *
 * The owner does not want the model trained on names that belong to someone
 * (companies, brands, products, sites, handles). "Anything at all, from names
 * to..." -- so this runs over text before it is trained on, and what it
 * replaces is reported so a person can check it.
 *
 * Own code, no outside list or model. It is a translator from names to
 * stand-ins:
 *
 *   1. web addresses, e-mail addresses and @handles      -> "website", "address", "handle"
 *   2. a name followed by a company ending (Inc, Corp...) -> "company"
 *   3. a word marked with a trade-mark sign              -> "brand"
 *   4. a hand-kept list of well known names, by kind     -> "company", "device", "program", ...
 *   5. names that are also ordinary words (Apple, Shell) -> only when capitalised mid-sentence
 *   6. strict mode (opt in): every capitalised word that is not starting a sentence -> "name"
 *
 * The same name always becomes the same stand-in, so the text still reads.
 *
 * Honest limits: a name that is in none of the lists and is not marked by a
 * company ending or trade-mark sign is NOT caught unless strict mode is on,
 * and strict mode also blanks people and places. The report lists every hit
 * so misses can be added to LISTS below.
 */

export type NameKind =
  | "company" | "device" | "program" | "website" | "brand"
  | "drink" | "car" | "store" | "network" | "name" | "address" | "handle";

export interface ScrubOptions {
  /** Also blank every capitalised word that is not the first word of a sentence. Default false. */
  strict?: boolean;
  /** Extra names to blank, by kind (matched ignoring case, whole words). */
  extra?: Partial<Record<NameKind, string[]>>;
}

export interface ScrubHit { original: string; standIn: string; kind: NameKind; count: number }
export interface ScrubResult { text: string; hits: ScrubHit[] }

/** Bare nouns; "the" or "a" is added or kept depending on what stands before. */
const NOUN: Record<NameKind, string> = {
  company: "company", device: "device", program: "program", website: "website", brand: "brand",
  drink: "drink", car: "car", store: "store", network: "network", name: "name",
  address: "address", handle: "handle",
};

/**
 * Words that began as someone's trade mark and became everyday words. Each one is swapped for the
 * plain thing it names, so the sentence still means the same. Matched ignoring case, with a plural.
 */
const GENERIC: Record<string, string> = {
  "kleenex": "tissue", "band-aid": "bandage", "bandaid": "bandage", "velcro": "hook-and-loop fastener",
  "frisbee": "flying disc", "jacuzzi": "hot tub", "taser": "stun gun", "xerox": "photocopy",
  "popsicle": "ice lolly", "styrofoam": "foam", "tupperware": "food container", "sharpie": "marker pen",
  "post-it": "sticky note", "q-tip": "cotton swab", "jet ski": "water scooter", "rollerblade": "inline skate",
  "hula hoop": "toy hoop", "ping-pong": "table tennis", "bubble wrap": "air-cushion wrap",
  "crock-pot": "slow cooker", "plexiglas": "acrylic sheet", "plexiglass": "acrylic sheet", "teflon": "non-stick coating",
  "scotch tape": "sticky tape", "jell-o": "gelatin dessert", "jello": "gelatin dessert",
  "aspirin": "pain pill", "escalator": "moving stairs", "zipper": "zip fastener", "trampoline": "bouncing mat",
  "thermos": "flask", "dumpster": "large bin", "cellophane": "clear wrap", "linoleum": "floor covering",
  "kerosene": "lamp oil", "onesie": "baby suit", "chapstick": "lip balm", "vaseline": "petroleum jelly",
  "tylenol": "pain pill", "advil": "pain pill", "lysol": "cleaner", "windex": "glass cleaner", "clorox": "bleach",
};

/** Distinctive names: matched ignoring case. Written by hand for this project. */
const LISTS: Partial<Record<NameKind, string[]>> = {
  company: split(`google|alphabet inc|microsoft|amazon.com|facebook|meta platforms|twitter|tesla|netflix|spotify|uber|airbnb|paypal|ebay|
    intel|nvidia|qualcomm|samsung|sony|nintendo|huawei|xiaomi|lenovo|hewlett-packard|ibm|cisco|salesforce|
    walmart|costco|starbucks|mcdonald's|mcdonalds|burger king|kfc|coca-cola|coca cola|pepsico|unilever|
    nike|adidas|gucci|prada|louis vuitton|chanel|toyota|honda|nissan|volkswagen|bmw|mercedes-benz|general motors|boeing|airbus|
    lockheed martin|raytheon|exxonmobil|chevron|gazprom|disney|warner bros|universal pictures|hbo|
    goldman sachs|jpmorgan|morgan stanley|citigroup|wells fargo|mastercard|american express|bloomberg|reuters|
    fedex|dhl|siemens|panasonic|toshiba|hitachi|nikon|ikea|pfizer|moderna|johnson & johnson|
    bayer|novartis|monsanto|ford motor company|yahoo|linkedin|snapchat|tiktok|bytedance|whatsapp|instagram|youtube|pinterest|
    openai|anthropic|deepmind|shopify|dropbox|github|gitlab|atlassian|vmware|red hat|mozilla|lego|mattel|hasbro|
    sears|kmart|kroger|safeway|ericsson|nokia|motorola|honeywell|hershey|cadbury`),
  device: split(`iphone|ipad|ipod|macbook|imac|apple watch|airpods|playstation|xbox|nintendo switch|game boy|gameboy|walkman|
    thinkpad|surface pro|fitbit|gopro|roomba|echo dot|chromecast|raspberry pi|hololens`),
  program: split(`macos|ubuntu|linux mint|photoshop|powerpoint|gmail|firefox|internet explorer|netscape|skype|minecraft|fortnite|tetris|
    pac-man|pacman|super mario|pokemon|pok\u00e9mon|world of warcraft|autocad|matlab|labview|visual studio|vs code|chatgpt|gpt-4|gpt-3|
    siri|cortana|tensorflow|pytorch|keras|numpy|jquery|node.js|django|kubernetes|docker|mysql|postgresql|mongodb|illustrator|
    garageband|itunes|napster|bittorrent|wordpress`),
  website: split(`wikipedia|wikimedia|stack overflow|stackoverflow|quora|craigslist|etsy|tumblr|myspace|flickr|imgur|vimeo|
    substack|google scholar|arxiv|pubmed|jstor|project gutenberg|imdb|tripadvisor`),
  brand: split(`oreo|doritos|cheetos|pringles|snickers|twix|kitkat|nutella|tabasco|colgate|barbie|hot wheels|play-doh|crayola|nerf|
    rubik's cube|levi's|levis|rolex|ray-ban|rayban|pampers|huggies|crocs|timberland`),
  drink: split(`pepsi|fanta|mountain dew|dr pepper|red bull|monster energy|gatorade|budweiser|heineken|corona beer|
    guinness|jack daniel's|smirnoff|absolut|nescafe|nespresso|lipton`),
  car: split(`camaro|prius|camry|mini cooper|land rover|range rover|ferrari|lamborghini|porsche|maserati|
    bugatti|rolls-royce|aston martin|volvo|subaru|mazda|hyundai|kia motors`),
  store: split(`best buy|home depot|lowe's|walgreens|cvs pharmacy|7-eleven|whole foods|trader joe's|aldi|lidl|tesco|carrefour|
    harrods|macy's|nordstrom|sephora|gamestop|toys r us|barnes & noble|blockbuster|radioshack`),
  network: split(`cnn|bbc|nbc|cbs|abc news|fox news|msnbc|espn|mtv|nickelodeon|cartoon network|pbs|npr|al jazeera|sky news`),
};

/**
 * Names that are also ordinary words: only blanked when capitalised and not starting a sentence.
 * Kept short on purpose: Mercury, Mars, Sun, Rust, Delta, Tide and the like are far more often the
 * planet, the star, the metal or the river than a company, so they are NOT here.
 */
const AMBIGUOUS: Partial<Record<NameKind, string[]>> = {
  company: split(`Apple|Visa|Ford|Tata`),
  program: split(`Windows|Linux|Unix|Safari|Chrome|Excel`),
  drink: split(`Coke`),
};

function split(s: string): string[] {
  return s.split("|").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Longest first, so "coca-cola" wins over "coca". */
const alternation = (names: string[]): string => [...names].sort((a, b) => b.length - a.length).map(escapeRe).join("|");

const COMPANY_ENDING = "(?:Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|LLC|LLP|GmbH|PLC|AG|S\\.A|N\\.V|B\\.V)";
const DETERMINER = /(?:^|\s)(a|an|the|this|that|these|those|his|her|its|their|our|my|your|of|every|each|some|any|no)\s+$/i;
const MONTHS_AND_DAYS = new Set(
  "January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(" "),
);

/** True when the text before `index` means a new sentence (or the start of the text) begins there. */
function startsSentence(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /["'“‘(\[\s]/.test(text[i])) i--;
  if (i < 0) return true;
  return /[.!?:\n]/.test(text[i]) && !/\b(?:Mr|Mrs|Ms|Dr|St|vs|etc|Jr|Sr)$/.test(text.slice(Math.max(0, i - 4), i));
}

export function scrubNames(input: string, options: ScrubOptions = {}): ScrubResult {
  const hits = new Map<string, ScrubHit>();
  let text = input;

  const note = (original: string, kind: NameKind): void => {
    const key = `${kind}:${original.toLowerCase()}`;
    const hit = hits.get(key);
    if (hit) hit.count++;
    else hits.set(key, { original, standIn: NOUN[kind], kind, count: 1 });
  };

  /** Build the stand-in for a match at `offset` of the CURRENT text. */
  const standIn = (whole: string, kind: NameKind, offset: number, source: string): string => {
    note(whole, kind);
    const noun = NOUN[kind];
    const before = source.slice(0, offset);
    if (DETERMINER.test(before)) return noun; // "the Apple phone" -> "the company phone"
    const phrase = `the ${noun}`;
    return startsSentence(source, offset) ? phrase[0].toUpperCase() + phrase.slice(1) : phrase;
  };

  const run = (re: RegExp, kind: NameKind, accept?: (m: string, offset: number, src: string) => boolean): void => {
    const src = text;
    text = src.replace(re, (m: string, ...rest: any[]) => {
      const offset = rest[rest.length - 2] as number;
      if (accept && !accept(m, offset, src)) return m;
      return standIn(m, kind, offset, src);
    });
  };

  // 1. addresses first, so the names inside them are not half-replaced.
  run(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "address");
  run(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, "website");
  run(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|edu|gov|ai|app|dev|tv|me)\b(?:\/[^\s<>"')\]]*)?/gi, "website");
  run(/(?<![\w@])@[A-Za-z_][\w]{1,30}\b/g, "handle");

  // 2. "Some Name Inc", "Big Thing Corp."
  run(new RegExp(`\\b[A-Z][\\w&'-]*(?:\\s+[A-Z][\\w&'-]*){0,3}[,]?\\s+${COMPANY_ENDING}(?![\\w-])\\.?`, "g"), "company");

  // 3. a word marked as a trade mark or registered name
  run(/\b[A-Za-z][\w-]*(?=\s?[™®])\s?[™®]/g, "brand");

  // 3b. words that were trade marks and became everyday words -> the plain thing they name.
  {
    const keys = Object.keys(GENERIC);
    const re = new RegExp(`(?<![\\w-])(${alternation(keys)})(s?)(?![\\w-])`, "gi");
    const src = text;
    text = src.replace(re, (m: string, name: string, plural: string, ...rest: any[]) => {
      const offset = rest[rest.length - 2] as number;
      const plain = GENERIC[name.toLowerCase()];
      note(name, "brand");
      const hit = hits.get(`brand:${name.toLowerCase()}`);
      if (hit) hit.standIn = plain;
      const out = plain + (plural && !plain.endsWith("s") ? "s" : "");
      return startsSentence(src, offset) ? out[0].toUpperCase() + out.slice(1) : out;
    });
  }

  // 4. the hand-kept lists, plus any the caller supplied.
  const merged: Partial<Record<NameKind, string[]>> = {};
  for (const [k, v] of Object.entries(LISTS)) merged[k as NameKind] = [...v];
  for (const [k, v] of Object.entries(options.extra ?? {})) merged[k as NameKind] = [...(merged[k as NameKind] ?? []), ...(v ?? [])];
  for (const [kind, names] of Object.entries(merged) as [NameKind, string[]][]) {
    if (!names.length) continue;
    run(new RegExp(`(?<![\\w-])(?:${alternation(names)})(?![\\w-])`, "gi"), kind);
  }

  // 5. ambiguous names: capitalised exactly, mid-sentence only.
  for (const [kind, names] of Object.entries(AMBIGUOUS) as [NameKind, string[]][]) {
    run(new RegExp(`(?<![\\w-])(?:${alternation(names)})(?![\\w-])`, "g"), kind, (_m, offset, src) => !startsSentence(src, offset));
  }

  // 6. strict: any capitalised word that is not starting a sentence.
  if (options.strict) {
    run(/(?<![\w'-])[A-Z][a-z]{1,}(?:[A-Z][a-z]+)*(?![\w-])/g, "name", (m, offset, src) =>
      m !== "I" && !MONTHS_AND_DAYS.has(m) && !startsSentence(src, offset));
  }

  // "a address" -> "an address", "an device" -> "a device"
  text = text.replace(/\b(a|an)(\s+)(address|company|device|program|website|brand|drink|car|store|network|name|handle)\b/gi, (_m, art: string, sp: string, noun: string) => {
    const want = /^[aeiou]/i.test(noun) ? "an" : "a";
    const fixed = art[0] === art[0].toUpperCase() ? want[0].toUpperCase() + want.slice(1) : want;
    return `${fixed}${sp}${noun}`;
  });

  return { text, hits: [...hits.values()].sort((a, b) => b.count - a.count) };
}
