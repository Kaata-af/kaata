package expo.modules.kaatabtclassic.mesh

/**
 * Native replication planner — Briar-parity step 4 (pure functions, no DB).
 *
 * Byte-faithful port of lib/replication/planner.ts: the version-vector sync core.
 * A replica describes what it holds as a per-author version vector
 * (device_id -> highest CONTIGUOUS author_seq) and the two sides exchange exactly
 * the missing ranges. Pure so it's unit-tested for parity against the JS.
 */
object MeshPlanner {

  /** device_id -> highest contiguous author_seq held (0 = nothing). */
  // (Vector is just Map<String, Int>.)

  data class SeqRange(val deviceId: String, val fromSeq: Int, val toSeq: Int)

  data class Contiguous(val frontier: Int, val gaps: List<SeqRange>)

  /**
   * Highest n such that 1..n are all present, plus gaps above it. Tolerant of
   * duplicates / unsorted / out-of-domain input (matches planner.ts
   * computeContiguous). gaps here carry a placeholder deviceId="" (the caller
   * stamps the real device).
   */
  fun computeContiguous(seqs: List<Int>): Contiguous {
    val valid = seqs.filter { it >= 1 }
    if (valid.isEmpty()) return Contiguous(0, emptyList())
    val sorted = valid.toSortedSet().toList()
    var frontier = 0
    var i = 0
    while (i < sorted.size && sorted[i] == frontier + 1) {
      frontier = sorted[i]
      i++
    }
    val gaps = ArrayList<SeqRange>()
    var prev = frontier
    while (i < sorted.size) {
      val s = sorted[i]
      if (s > prev + 1) gaps.add(SeqRange("", prev + 1, s - 1))
      prev = s
      i++
    }
    return Contiguous(frontier, gaps)
  }

  /**
   * Plan what WE send a peer: for every author where our frontier exceeds the
   * peer's, the inclusive range (peer+1 .. ours). Sorted by device_id for stable,
   * symmetric plans. Matches planner.ts planRangesToSend.
   */
  fun planRangesToSend(local: Map<String, Int>, peer: Map<String, Int>): List<SeqRange> {
    val ranges = ArrayList<SeqRange>()
    for (device in local.keys.sorted()) {
      val have = local[device] ?: 0
      val theirs = peer[device] ?: 0
      if (have > theirs) ranges.add(SeqRange(device, theirs + 1, have))
    }
    return ranges
  }

  /**
   * Split planned ranges into batches of at most batchSize events, preserving
   * per-author order (a batch may span authors). Matches planner.ts.
   */
  fun splitIntoBatches(ranges: List<SeqRange>, batchSize: Int): List<List<SeqRange>> {
    require(batchSize >= 1) { "batchSize must be >= 1, got $batchSize" }
    val batches = ArrayList<List<SeqRange>>()
    var current = ArrayList<SeqRange>()
    var currentCount = 0
    for (r in ranges) {
      var from = r.fromSeq
      while (from <= r.toSeq) {
        val room = batchSize - currentCount
        val take = minOf(room, r.toSeq - from + 1)
        current.add(SeqRange(r.deviceId, from, from + take - 1))
        currentCount += take
        from += take
        if (currentCount == batchSize) {
          batches.add(current)
          current = ArrayList()
          currentCount = 0
        }
      }
    }
    if (current.isNotEmpty()) batches.add(current)
    return batches
  }
}
