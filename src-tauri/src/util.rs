//! Small shared helpers.

use std::sync::{Mutex, MutexGuard};

/// Locks a mutex, recovering from poisoning instead of panicking.
///
/// A poisoned lock only means another thread panicked mid-update; the data is
/// still structurally sound. With `panic = "abort"` in release, a panic here
/// would take the whole app down, so recovering is strictly better than
/// unwrapping.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
