/**
 * Smart Arabic & Phone Customer Search Utilities
 * Used by backend /customers/search, /customers/by-phone, /customers
 */

function normalizePartyWhitespace(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function toEnglishDigits(value) {
  return String(value || "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function normalizeCustomerSearchText(value) {
  return toEnglishDigits(value)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // strip Arabic tashkeel & tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىئ]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/[\/\\\-_,.()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(normalized) {
  return String(normalized || "").replace(/\s+/g, "");
}

function normalizePhoneDigits(value) {
  return toEnglishDigits(value).replace(/[^\d]/g, "");
}

const EN_TO_AR = {
  q: "ض",
  w: "ص",
  e: "ث",
  r: "ق",
  t: "ف",
  y: "غ",
  u: "ع",
  i: "ه",
  o: "خ",
  p: "ح",
  a: "ش",
  s: "س",
  d: "ي",
  f: "ب",
  g: "ل",
  h: "ا",
  j: "ت",
  k: "ن",
  l: "م",
  z: "ئ",
  x: "ء",
  c: "ؤ",
  v: "ر",
  b: "لا",
  n: "ى",
  m: "ة",
  ";": "ك",
  "'": "ط",
  ",": "و",
  ".": "ز",
  "/": "ظ",
  "[": "ج",
  "]": "د",
};

function hasLatin(value) {
  return /[a-zA-Z]/.test(String(value || ""));
}

function enToArKeyboard(value) {
  return String(value || "")
    .toLowerCase()
    .split("")
    .map((ch) => EN_TO_AR[ch] ?? ch)
    .join("");
}

/**
 * Bounded Damerau-Levenshtein distance for typo tolerance.
 * Returns Infinity if distance exceeds maxDist.
 */
function damerauLevenshtein(a, b, maxDist = 2) {
  const s1 = String(a || "");
  const s2 = String(b || "");
  const m = s1.length;
  const n = s2.length;

  if (Math.abs(m - n) > maxDist) return Infinity;
  if (m === 0) return n <= maxDist ? n : Infinity;
  if (n === 0) return m <= maxDist ? m : Infinity;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        s1[i - 1] === s2[j - 2] &&
        s1[i - 2] === s2[j - 1]
      ) {
        val = Math.min(val, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist && i < m && Math.abs((m - i) - (n - m)) > maxDist) {
      // keep scanning safely; tiny strings anyway (<= 20 chars)
    }
  }

  return dp[m][n] <= maxDist ? dp[m][n] : Infinity;
}

function escapeSqlLike(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

function getCustomerPhonesList(customer) {
  const list = [];
  if (Array.isArray(customer.phones)) {
    for (const p of customer.phones) {
      const ph = typeof p === "string" ? p : p?.phone;
      if (ph && !list.includes(ph)) list.push(ph);
    }
  }
  if (customer.phone && !list.includes(customer.phone)) {
    list.unshift(customer.phone);
  }
  return list;
}

function scoreVariantAgainstCustomer(customer, normQuery, rawTrimmed, queryDigits) {
  const normName = customer._normName;
  const compactName = customer._compactName;
  const nameTokens = customer._nameTokens;
  const compactQuery = compactText(normQuery);
  const queryTokens = normQuery ? normQuery.split(/\s+/).filter(Boolean) : [];
  const phonesList = customer._phonesList;
  const phonesDigits = customer._phonesDigits;

  let bestScore = -1;
  let matchType = null;
  let matchedPhone = phonesList[0] || null;

  // 1. Exact ID match (#189 or 189)
  const cleanIdQuery = rawTrimmed.startsWith("#")
    ? toEnglishDigits(rawTrimmed.slice(1)).trim()
    : queryDigits;
  if (cleanIdQuery && String(customer.id) === cleanIdQuery) {
    bestScore = 10500;
    matchType = "exact_id";
  }

  // 2. Phone matching (if query has at least 2 digits)
  if (queryDigits && queryDigits.length >= 2) {
    for (let i = 0; i < phonesDigits.length; i++) {
      const pd = phonesDigits[i];
      if (!pd) continue;
      if (pd === queryDigits) {
        if (11000 > bestScore) {
          bestScore = 11000;
          matchType = "exact_phone";
          matchedPhone = phonesList[i];
        }
      } else if (pd.startsWith(queryDigits)) {
        if (6500 > bestScore) {
          bestScore = 6500;
          matchType = "prefix_phone";
          matchedPhone = phonesList[i];
        }
      } else if (pd.includes(queryDigits)) {
        if (2600 > bestScore) {
          bestScore = 2600;
          matchType = "contains_phone";
          matchedPhone = phonesList[i];
        }
      }
    }
  }

  // 3. Name matching (normalized)
  if (normQuery && normName) {
    if (normName === normQuery || (compactQuery && compactName === compactQuery)) {
      if (10000 > bestScore) {
        bestScore = 10000;
        matchType = "exact_name";
      }
    } else if (normName.startsWith(normQuery)) {
      const bonus = Math.max(0, 80 - Math.min(normName.length, 80));
      if (5500 + bonus > bestScore) {
        bestScore = 5500 + bonus;
        matchType = "starts_with";
      }
    } else if (compactQuery && compactName.startsWith(compactQuery)) {
      const bonus = Math.max(0, 80 - Math.min(compactName.length, 80));
      if (5200 + bonus > bestScore) {
        bestScore = 5200 + bonus;
        matchType = "compact_starts_with";
      }
    } else if (
      queryTokens.length === 1 &&
      nameTokens.some((tok) => tok.startsWith(queryTokens[0]))
    ) {
      const tokIdx = nameTokens.findIndex((tok) => tok.startsWith(queryTokens[0]));
      const posBonus = Math.max(0, 100 - tokIdx * 20);
      if (3500 + posBonus > bestScore) {
        bestScore = 3500 + posBonus;
        matchType = "word_starts_with";
      }
    } else if (
      queryTokens.length > 1 &&
      queryTokens.every((qt) => nameTokens.some((nt) => nt.startsWith(qt)))
    ) {
      // Check if order is preserved for extra boost
      let lastIdx = -1;
      let ordered = true;
      for (const qt of queryTokens) {
        const foundIdx = nameTokens.findIndex((nt, i) => i > lastIdx && nt.startsWith(qt));
        if (foundIdx === -1) {
          ordered = false;
          break;
        }
        lastIdx = foundIdx;
      }
      const s = ordered ? 4200 : 3200;
      if (s > bestScore) {
        bestScore = s;
        matchType = ordered ? "ordered_word_prefixes" : "word_prefixes";
      }
    } else if (normName.includes(normQuery)) {
      if (2200 > bestScore) {
        bestScore = 2200;
        matchType = "contains_phrase";
      }
    } else if (compactQuery && compactName.includes(compactQuery)) {
      if (2000 > bestScore) {
        bestScore = 2000;
        matchType = "contains_compact";
      }
    } else if (
      queryTokens.length > 1 &&
      queryTokens.every((qt) => {
        const cqt = compactText(qt);
        const qtDigits = normalizePhoneDigits(qt);
        return (
          normName.includes(qt) ||
          (cqt && compactName.includes(cqt)) ||
          (qtDigits.length >= 2 && phonesDigits.some((pd) => pd.includes(qtDigits)))
        );
      })
    ) {
      if (1700 > bestScore) {
        bestScore = 1700;
        matchType = "multi_token";
      }
    } else if (
      queryTokens.length === 1 &&
      queryTokens[0].length >= 2 &&
      normName.includes(queryTokens[0])
    ) {
      if (1400 > bestScore) {
        bestScore = 1400;
        matchType = "contains_token";
      }
    }
  }

  if (bestScore >= 0) {
    return { score: bestScore, matchType, matchedPhone };
  }

  return null;
}

function scoreFuzzyAgainstCustomer(customer, normQuery) {
  const queryTokens = normQuery
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  if (queryTokens.length === 0) return null;

  const nameTokens = customer._nameTokens;
  if (!nameTokens || nameTokens.length === 0) return null;

  let totalPenalty = 0;
  for (const qt of queryTokens) {
    const maxDist = qt.length >= 6 ? 2 : 1;
    // Fast exact/substring hit for this token first
    if (nameTokens.some((nt) => nt.includes(qt))) {
      continue;
    }
    let minTokenDist = Infinity;
    const qtBare = qt.startsWith("ال") && qt.length >= 4 ? qt.slice(2) : qt;
    for (const nt of nameTokens) {
      const ntBare = nt.startsWith("ال") && nt.length >= 4 ? nt.slice(2) : nt;
      const dist = damerauLevenshtein(qt, nt, maxDist);
      if (dist < minTokenDist) minTokenDist = dist;
      if (ntBare !== nt || qtBare !== qt) {
        const bareDist = damerauLevenshtein(qtBare, ntBare, maxDist);
        if (bareDist < minTokenDist) minTokenDist = bareDist;
      }
      // Also test prefix comparison if name token is longer
      if (nt.length > qt.length && nt.length >= qt.length + 1) {
        const prefDist = damerauLevenshtein(qt, nt.slice(0, qt.length), 1);
        if (prefDist < minTokenDist) minTokenDist = prefDist;
      }
    }
    if (!Number.isFinite(minTokenDist)) {
      return null;
    }
    totalPenalty += minTokenDist;
  }

  return {
    score: Math.max(100, 600 - totalPenalty * 150),
    matchType: "fuzzy",
    matchedPhone: customer._phonesList[0] || null,
  };
}

function prepareCustomerForSearch(rawCustomer) {
  const name = String(rawCustomer.name || "");
  const normName = normalizeCustomerSearchText(name);
  const phonesList = getCustomerPhonesList(rawCustomer);
  return {
    ...rawCustomer,
    _normName: normName,
    _compactName: compactText(normName),
    _nameTokens: normName ? normName.split(/\s+/).filter(Boolean) : [],
    _phonesList: phonesList,
    _phonesDigits: phonesList.map(normalizePhoneDigits),
  };
}

function searchAndRankCustomers(preparedCustomers, rawQuery, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 30));
  const rawTrimmed = toEnglishDigits(String(rawQuery || "")).trim();
  if (!rawTrimmed) return [];

  const normQuery = normalizeCustomerSearchText(rawTrimmed);
  const queryDigits = normalizePhoneDigits(rawTrimmed);
  const latinKeyboardQuery = hasLatin(rawTrimmed)
    ? normalizeCustomerSearchText(enToArKeyboard(rawTrimmed))
    : "";

  const strictMatches = [];
  const seenIds = new Set();

  for (const c of preparedCustomers) {
    let hit = scoreVariantAgainstCustomer(c, normQuery, rawTrimmed, queryDigits);
    if (!hit && latinKeyboardQuery && latinKeyboardQuery !== normQuery) {
      const kbHit = scoreVariantAgainstCustomer(
        c,
        latinKeyboardQuery,
        rawTrimmed,
        "",
      );
      if (kbHit) {
        hit = { ...kbHit, score: kbHit.score - 50, matchType: `kb_${kbHit.matchType}` };
      }
    }
    if (hit) {
      seenIds.add(c.id);
      const activityBonus = Math.min(Number(c.invoice_count || 0), 300);
      strictMatches.push({
        customer: c,
        score: hit.score + activityBonus,
        matchType: hit.matchType,
        matchedPhone: hit.matchedPhone,
      });
    }
  }

  // Fuzzy fallback if strict matches are few and query is >= 3 chars non-numeric
  const fuzzyCandidates = [];
  if (strictMatches.length < 8) {
    const fuzzyQuery =
      latinKeyboardQuery && strictMatches.length === 0
        ? latinKeyboardQuery
        : normQuery;
    if (fuzzyQuery && compactText(fuzzyQuery).length >= 3) {
      for (const c of preparedCustomers) {
        if (seenIds.has(c.id)) continue;
        const fHit = scoreFuzzyAgainstCustomer(c, fuzzyQuery);
        if (fHit) {
          const activityBonus = Math.min(Number(c.invoice_count || 0), 200);
          fuzzyCandidates.push({
            customer: c,
            score: fHit.score + activityBonus,
            matchType: fHit.matchType,
            matchedPhone: fHit.matchedPhone,
          });
        }
      }
    }
  }

  const combined = [...strictMatches, ...fuzzyCandidates];
  combined.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const invDiff = Number(b.customer.invoice_count || 0) - Number(a.customer.invoice_count || 0);
    if (invDiff !== 0) return invDiff;
    return String(a.customer.name || "").localeCompare(String(b.customer.name || ""), "ar");
  });

  return combined.slice(0, limit).map(({ customer, matchedPhone, matchType }) => ({
    id: customer.id,
    name: customer.name,
    apply_items_discount: customer.apply_items_discount,
    is_market_customer: Boolean(customer.is_market_customer),
    phone: matchedPhone || customer._phonesList[0] || null,
    phones: customer._phonesList,
    invoice_count: Number(customer.invoice_count || 0),
    match_type: matchType,
  }));
}

module.exports = {
  normalizePartyWhitespace,
  toEnglishDigits,
  normalizeCustomerSearchText,
  compactText,
  normalizePhoneDigits,
  enToArKeyboard,
  damerauLevenshtein,
  escapeSqlLike,
  prepareCustomerForSearch,
  searchAndRankCustomers,
};
