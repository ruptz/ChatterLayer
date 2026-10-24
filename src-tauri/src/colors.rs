//! Speaker colours.

use std::collections::{HashMap, HashSet};

/// Bright, well-separated hues that all clear WCAG AA against the overlay's
/// dark backdrop — captions are an accessibility feature first.
pub const PALETTE: [&str; 16] = [
    "#FF6B6B", // red
    "#4ECDC4", // teal
    "#FFD93D", // yellow
    "#6BCB77", // green
    "#4D96FF", // blue
    "#FF9F45", // orange
    "#C780FA", // purple
    "#FF6FB5", // pink
    "#00D2FF", // cyan
    "#B5E48C", // lime
    "#F4A261", // sand
    "#9D4EDD", // violet
    "#52D1DC", // aqua
    "#FFB4A2", // salmon
    "#A0C4FF", // periwinkle
    "#E8E337", // citron
];

/// FNV-1a over UTF-16 code units, as the Electron build hashed JS strings, so
/// everyone keeps the colour they had.
pub fn fnv1a(s: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for unit in s.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn hashed(user_id: &str) -> usize {
    fnv1a(user_id) as usize % PALETTE.len()
}

/// The colour a user gets in isolation. Fallback for people who have left.
pub fn color_for_user(user_id: &str, overrides: &HashMap<String, String>) -> String {
    match overrides.get(user_id) {
        Some(c) => c.clone(),
        None => PALETTE[hashed(user_id)].to_string(),
    }
}

/// Assign colours across a whole call so no two people share one.
///
/// Hashing alone isn't enough: with 16 colours, seven random users collide
/// ~78% of the time. Each user still prefers their hashed colour, but
/// collisions probe forward through the palette. Sorted-ID iteration keeps the
/// result deterministic for a given set of people.
pub fn assign_colors<'a>(
    user_ids: impl IntoIterator<Item = &'a str>,
    overrides: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut ids: Vec<&str> = user_ids.into_iter().collect();
    ids.sort();
    let mut assignment = HashMap::new();
    let mut taken = HashSet::new();

    for id in &ids {
        if let Some(c) = overrides.get(*id) {
            assignment.insert(id.to_string(), c.clone());
            taken.insert(c.to_uppercase());
        }
    }
    for id in &ids {
        if assignment.contains_key(*id) {
            continue;
        }
        let start = hashed(id);
        let chosen = (0..PALETTE.len())
            .map(|i| PALETTE[(start + i) % PALETTE.len()])
            .find(|c| !taken.contains(&c.to_uppercase()))
            // Past 16 concurrent speakers duplication is unavoidable.
            .unwrap_or(PALETTE[start]);
        assignment.insert(id.to_string(), chosen.to_string());
        taken.insert(chosen.to_uppercase());
    }
    assignment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_js_hash() {
        // fnv1a('123') in the Electron build.
        assert_eq!(fnv1a("123"), 0x7238631b);
    }

    #[test]
    fn nobody_shares_a_colour() {
        let ids: Vec<String> = (0..10).map(|i| format!("user{i}")).collect();
        let a = assign_colors(ids.iter().map(String::as_str), &HashMap::new());
        let distinct: HashSet<_> = a.values().collect();
        assert_eq!(distinct.len(), 10);
    }
}
