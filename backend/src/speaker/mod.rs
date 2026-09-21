pub mod client;
pub mod name_extract;
pub mod store;

pub use client::SpeakerIdClient;
pub use name_extract::extract_name;
pub use store::{SpeakerMatch, SpeakerStore};
