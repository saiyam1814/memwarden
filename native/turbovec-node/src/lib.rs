//! Node bindings for `turbovec::IdMapIndex`.
//!
//! Thin FFI shim: every method maps 1:1 onto the crate API and converts
//! errors into JS exceptions instead of panics. The two documented panic
//! paths of `search_with_allowlist` (empty allowlist, allowlist id not in
//! the index) are guarded here — the binding filters unknown ids and
//! returns an empty result set for an effectively-empty allowlist, so a
//! caller can never crash the process through the mask argument.
//!
//! Ids are JS BigInt (u64). String-key mapping, persistence orchestration
//! and fallback behavior live in memwarden's TypeScript loader
//! (src/functions/turbovec-backend.ts), not here.

#[macro_use]
extern crate napi_derive;

// Force the statically-linked OpenBLAS backend to be linked in on Linux so
// ndarray's `blas` feature (pulled in transitively by turbovec) resolves to
// a vendored static libopenblas instead of a runtime libopenblas.so.0.
// macOS resolves BLAS to the system Accelerate framework and needs nothing.
#[cfg(target_os = "linux")]
extern crate blas_src;

use napi::bindgen_prelude::*;
use turbovec::IdMapIndex;

/// One search result batch: `ids[i]` scored `scores[i]`, best first.
/// Length is `min(k, len, allowlist size)` — turbovec does not pad.
#[napi(object)]
pub struct SearchHits {
  pub ids: BigUint64Array,
  pub scores: Float32Array,
}

#[napi]
pub struct TurbovecIndex {
  inner: IdMapIndex,
}

fn js_err<E: std::fmt::Display>(e: E) -> Error {
  Error::from_reason(format!("turbovec: {e}"))
}

#[napi]
impl TurbovecIndex {
  /// `dims` must be a positive multiple of 8 and <= 65536;
  /// `bitWidth` one of 2, 3, 4.
  #[napi(constructor)]
  pub fn new(dims: u32, bit_width: u32) -> Result<Self> {
    let inner = IdMapIndex::new(dims as usize, bit_width as usize).map_err(js_err)?;
    Ok(Self { inner })
  }

  /// Add `ids.length` vectors from a flat f32 buffer of length
  /// `ids.length * dims`. Rejects duplicate ids (in the index or the
  /// batch), shape mismatches, and non-finite coordinates — atomically:
  /// on error nothing was added.
  #[napi]
  pub fn add_with_ids(&mut self, vectors: Float32Array, ids: BigUint64Array) -> Result<()> {
    self
      .inner
      .add_with_ids(vectors.as_ref(), ids.as_ref())
      .map_err(js_err)
  }

  /// O(1). Returns true when the id was present and removed.
  #[napi]
  pub fn remove(&mut self, id: BigInt) -> Result<bool> {
    Ok(self.inner.remove(u64_from_bigint(id)?))
  }

  /// True when a vector with this external id is stored.
  #[napi]
  pub fn contains(&self, id: BigInt) -> Result<bool> {
    Ok(self.inner.contains(u64_from_bigint(id)?))
  }

  /// Top-`k` for a single query vector (length `dims`). When `allowlist`
  /// is given, only those external ids can be returned; ids in the
  /// allowlist that are not (or no longer) in the index are ignored, and
  /// an effectively empty allowlist yields an empty result — never a panic.
  #[napi]
  pub fn search(
    &self,
    query: Float32Array,
    k: u32,
    allowlist: Option<BigUint64Array>,
  ) -> Result<SearchHits> {
    let dim = self.inner.dim();
    if query.len() != dim {
      return Err(js_err(format!(
        "query has {} dims, index expects {dim}",
        query.len()
      )));
    }
    let empty = || SearchHits {
      ids: Vec::<u64>::new().into(),
      scores: Vec::<f32>::new().into(),
    };
    if self.inner.is_empty() || k == 0 {
      return Ok(empty());
    }
    // Guard the crate's documented panics: drop unknown ids, and treat a
    // filtered-to-empty allowlist as "nothing is allowed".
    let filtered: Option<Vec<u64>> = allowlist.map(|ids| {
      ids
        .as_ref()
        .iter()
        .copied()
        .filter(|id| self.inner.contains(*id))
        .collect()
    });
    if matches!(&filtered, Some(f) if f.is_empty()) {
      return Ok(empty());
    }
    let (scores, ids) =
      self
        .inner
        .search_with_allowlist(query.as_ref(), k as usize, filtered.as_deref());
    Ok(SearchHits {
      ids: ids.into(),
      scores: scores.into(),
    })
  }

  /// Persist to a `.tvim` file (turbovec format v3, validated on load).
  #[napi]
  pub fn save(&self, path: String) -> Result<()> {
    self.inner.write(&path).map_err(js_err)
  }

  /// Load a `.tvim` file previously written by `save`.
  #[napi(factory)]
  pub fn load(path: String) -> Result<TurbovecIndex> {
    Ok(Self {
      inner: IdMapIndex::load(&path).map_err(js_err)?,
    })
  }

  /// Number of stored vectors.
  #[napi(getter)]
  pub fn len(&self) -> u32 {
    self.inner.len() as u32
  }

  /// Vector dimensionality this index was constructed with.
  #[napi(getter)]
  pub fn dims(&self) -> u32 {
    self.inner.dim() as u32
  }

  /// Bits per coordinate (2, 3 or 4).
  #[napi(getter)]
  pub fn bit_width(&self) -> u32 {
    self.inner.bit_width() as u32
  }
}

fn u64_from_bigint(id: BigInt) -> Result<u64> {
  let (signed, value, lossless) = id.get_u64();
  if signed || !lossless {
    return Err(js_err("id must be an unsigned 64-bit BigInt"));
  }
  Ok(value)
}
