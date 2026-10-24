//! Caption word filter.
//!
//! Speech recognition output goes straight onto a live stream, so anything the
//! recogniser emits is broadcast before a human can react. This masks slurs on
//! the way out.
//!
//! The default list is racial and ethnic slurs only — the category that gets
//! channels banned and does real harm. Anything else is left to the streamer's
//! own list, since standards differ per platform and community.

use std::collections::HashSet;

/// Base terms. Common plural and agentive endings are generated in `expand`,
/// and spacing is irrelevant to matching (see `compact`), so only the root
/// form is listed.
const DEFAULT_TERMS: &[&str] = &[
    "nigger", "nigga", "niggah", "chink", "gook", "spic", "wetback", "beaner", "kike", "heeb",
    "jigaboo", "sambo", "darkie", "darky", "pickaninny", "golliwog", "towelhead", "raghead",
    "paki", "zipperhead", "slanteye", "gyppo", "redskin", "injun", "squaw", "abo", "boong",
    "coolie", "wop", "dago", "honky", "mulatto", "quadroon", "octoroon", "tarbaby", "coon",
];

/// Multi-word slurs. Matched the same way as `DEFAULT_TERMS`, so a term
/// written here as one word is still caught when spoken as two.
const DEFAULT_PHRASES: &[&str] = &[
    "porch monkey",
    "jungle bunny",
    "sand nigger",
    "camel jockey",
    "curry muncher",
    "cotton picker",
    "half breed",
];

/// How many adjacent words may be joined into one candidate. Four leaves room
/// beyond the worst real case ("pick a ninny", three).
const MAX_JOIN_WORDS: usize = 4;

/// Joins shorter than this are ignored. Without the floor, short terms fire on
/// innocent pairs — "go ok" is "gook" once the space is gone. Single words are
/// still matched at any length.
const MIN_JOIN_LENGTH: usize = 5;

/// Strip everything but letters.
fn normalize(token: &str) -> String {
    token.to_lowercase().chars().filter(|c| c.is_ascii_lowercase()).collect()
}

/// Drop the spaces from an entry. Where a recogniser puts word boundaries is a
/// coin toss ("zipper head", "pick a ninny"), so matching on the space-stripped
/// form makes every split the same lookup.
fn compact(entry: &str) -> String {
    entry.split_whitespace().map(normalize).collect()
}

pub struct Filter {
    enabled: bool,
    keys: HashSet<String>,
    longest: usize,
}

impl Filter {
    pub fn new(enabled: bool, custom: &[String]) -> Self {
        let mut keys = HashSet::new();
        let mut longest = 0;
        if enabled {
            let entries = DEFAULT_TERMS
                .iter()
                .chain(DEFAULT_PHRASES)
                .map(|s| s.to_string())
                .chain(custom.iter().cloned());
            for entry in entries {
                let base = compact(&entry);
                if base.is_empty() {
                    continue;
                }
                for variant in [base.clone(), format!("{base}s"), format!("{base}es"), format!("{base}z")] {
                    longest = longest.max(variant.len());
                    keys.insert(variant);
                }
            }
        }
        Self { enabled, keys, longest }
    }

    /// Mask any filtered term, preserving spacing and word length. Returns the
    /// text and how many words were masked.
    pub fn mask(&self, text: &str) -> (String, usize) {
        if !self.enabled || self.keys.is_empty() || text.is_empty() {
            return (text.to_string(), 0);
        }

        // Words and the whitespace between them, so spacing is rebuilt exactly.
        let mut parts: Vec<String> = Vec::new();
        let mut current = String::new();
        let mut in_space = false;
        for c in text.chars() {
            if c.is_whitespace() != in_space && !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            in_space = c.is_whitespace();
            current.push(c);
        }
        if !current.is_empty() {
            parts.push(current);
        }

        let mut slots = Vec::new();
        let mut words = Vec::new();
        for (i, p) in parts.iter().enumerate() {
            if p.starts_with(char::is_whitespace) {
                continue;
            }
            let w = normalize(p);
            if !w.is_empty() {
                slots.push(i);
                words.push(w);
            }
        }

        let mut hits = HashSet::new();
        for i in 0..words.len() {
            let mut joined = String::new();
            for n in 0..MAX_JOIN_WORDS {
                let Some(w) = words.get(i + n) else { break };
                joined.push_str(w);
                if joined.len() > self.longest {
                    break;
                }
                if n > 0 && joined.len() < MIN_JOIN_LENGTH {
                    continue;
                }
                if self.keys.contains(&joined) {
                    hits.extend(i..=i + n);
                }
            }
        }
        if hits.is_empty() {
            return (text.to_string(), 0);
        }
        for &at in &hits {
            let slot = slots[at];
            parts[slot] = "*".repeat(parts[slot].chars().count());
        }
        (parts.concat(), hits.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_split_terms_and_keeps_spacing() {
        let f = Filter::new(true, &[]);
        assert_eq!(f.mask("a  zipper head here"), ("a  ****** **** here".to_string(), 2));
        assert_eq!(f.mask("go ok then").1, 0);
    }

    #[test]
    fn custom_terms_and_off() {
        let f = Filter::new(true, &["darn".into()]);
        assert_eq!(f.mask("darns!").0, "******");
        assert_eq!(Filter::new(false, &[]).mask("coon").1, 0);
    }
}
