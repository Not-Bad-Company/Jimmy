/// Best-effort extraction of a spoken name from a reply given after Jimmy
/// asked (or might ask) who's speaking. Deliberately simple pattern
/// matching, not a full NLU pipeline — this is intentionally run on every
/// message from an unidentified speaker rather than requiring a "we just
/// asked for a name" flag (there's no clean signal for that without
/// parsing the LLM's own output), so the stoplist below carries the real
/// weight of avoiding false positives on ordinary sentences. A miss just
/// means Jimmy asks again next turn — that's the LLM's job, not this
/// function's.
const NON_NAME_WORDS: &[&str] = &[
    "not", "just", "still", "also", "going", "trying", "kind", "sort", "really", "very", "so",
    "feeling", "doing", "gonna", "about", "here", "done", "fine", "good", "okay", "ok", "tired",
    "busy", "sorry", "sure", "confused", "curious", "no", "yes", "maybe",
];

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

pub fn extract_name(utterance: &str) -> Option<String> {
    let lower = utterance.to_lowercase();
    let patterns = [
        "my name is ",
        "i'm ",
        "im ",
        "i am ",
        "it's ",
        "its ",
        "this is ",
        "call me ",
    ];

    for pat in patterns {
        if let Some(idx) = lower.find(pat) {
            let after = &utterance[idx + pat.len()..];
            if let Some(word) = after
                .split(|c: char| !c.is_alphanumeric())
                .find(|w| !w.is_empty())
            {
                if word.len() >= 2 && !NON_NAME_WORDS.contains(&word.to_lowercase().as_str()) {
                    return Some(capitalize(word));
                }
            }
        }
    }

    // Bare single-word reply (e.g. just "Daan.") — one alphabetic word,
    // short enough to plausibly be a name rather than a sentence.
    let trimmed = utterance.trim().trim_end_matches(['.', '!', '?']);
    if !trimmed.is_empty()
        && trimmed.chars().all(|c| c.is_alphabetic())
        && trimmed.split_whitespace().count() == 1
        && trimmed.len() <= 20
        && !NON_NAME_WORDS.contains(&trimmed.to_lowercase().as_str())
    {
        return Some(capitalize(trimmed));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_from_my_name_is() {
        assert_eq!(extract_name("My name is Daan."), Some("Daan".to_string()));
    }

    #[test]
    fn extracts_from_im_contraction() {
        assert_eq!(extract_name("I'm Sarah"), Some("Sarah".to_string()));
    }

    #[test]
    fn extracts_from_call_me() {
        assert_eq!(extract_name("call me Mo."), Some("Mo".to_string()));
    }

    #[test]
    fn extracts_bare_single_word_reply() {
        assert_eq!(extract_name("Daan"), Some("Daan".to_string()));
    }

    #[test]
    fn rejects_non_name_words_after_im() {
        // "I'm not sure" must NOT extract "Not" as a name — this is
        // exactly the false-positive the stoplist exists to catch.
        assert_eq!(extract_name("I'm not sure"), None);
        assert_eq!(extract_name("I'm just tired"), None);
    }

    #[test]
    fn rejects_unrelated_sentences() {
        assert_eq!(extract_name("I don't know what you mean"), None);
        assert_eq!(extract_name("what time is it"), None);
    }

    #[test]
    fn rejects_multi_word_bare_replies() {
        // A full sentence of alphabetic words shouldn't be mistaken for a
        // bare name reply.
        assert_eq!(extract_name("no idea honestly"), None);
    }
}
