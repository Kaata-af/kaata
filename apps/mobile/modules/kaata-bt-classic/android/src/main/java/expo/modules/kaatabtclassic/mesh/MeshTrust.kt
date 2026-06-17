package expo.modules.kaatabtclassic.mesh

import org.json.JSONObject

/**
 * Membership-chain fold + peer-proof verdict — Briar-parity step 7, the crown
 * jewel. Faithful port of lib/trust/chain.ts.
 *
 * Deterministic + skip-invalid: every replica folding the same events computes
 * byte-identical state; an unauthorized/malformed event is recorded as a
 * conflict and skipped, never fatal. Authorization is evaluated against the
 * state built SO FAR (the fold runs in HLC order) = lawful-at-HLC. All crypto
 * goes through MeshEventSig (proven byte-identical to the JS).
 *
 * Verified by scenario parity tests (a JS-signed chain folded here must reach the
 * identical members/devices/verdict) before cutover.
 */
object MeshTrust {

  const val WITNESS_FRESHNESS_MS = 7L * 24 * 60 * 60 * 1000

  val MEMBERSHIP_EVENT_TYPES =
    setOf(
      "vault_member_added",
      "vault_member_role_changed",
      "vault_member_removed",
      "vault_device_added",
      "vault_device_removed",
    )

  class MemberEntry(val accountId: String, var role: String, var removed: Boolean)

  class DeviceEntry(
    val devicePubkey: String,
    var deviceId: String,
    var accountId: String,
    var removed: Boolean,
  )

  data class Conflict(val eventId: String, val eventType: String, val reason: String)

  class MembershipState {
    val members = HashMap<String, MemberEntry>()
    val devices = HashMap<String, DeviceEntry>()
    val conflicts = ArrayList<Conflict>()
    var hasGenesis = false
  }

  sealed class ProofVerdict {
    // device_id surfaced too (proof.ts verifyPeerMembership) — the handshake
    // checks the peer's claimed device_id against this chain binding.
    data class Ok(val accountId: String, val role: String, val deviceId: String) : ProofVerdict()
    data class Fail(val reason: String) : ProofVerdict()
  }

  // --- HLC total order (mirrors hlc.ts / chain.ts hlcCompare) ---------------
  private fun hlcCompare(a: MeshEvent, b: MeshEvent): Int {
    if (a.hlcPms != b.hlcPms) return a.hlcPms.compareTo(b.hlcPms)
    if (a.hlcL != b.hlcL) return a.hlcL.compareTo(b.hlcL)
    return a.hlcDid.compareTo(b.hlcDid)
  }

  // --- witness tuples (canonical, shared byte-for-byte with the backend) ----
  private fun deviceWitnessTuple(
    vaultId: String,
    accountId: String,
    deviceId: String,
    devicePubkeyB64: String,
    issuedAtMs: Long,
  ): JSONObject =
    JSONObject().apply {
      put("account_id", accountId)
      put("device_id", deviceId)
      put("device_pubkey_b64", devicePubkeyB64)
      put("issued_at_ms", issuedAtMs)
      put("vault_id", vaultId)
    }

  private fun memberWitnessTuple(
    vaultId: String,
    accountId: String,
    inviterAccountId: String,
    role: String,
    issuedAtMs: Long,
  ): JSONObject =
    JSONObject().apply {
      put("account_id", accountId)
      put("inviter_account_id", inviterAccountId)
      put("issued_at_ms", issuedAtMs)
      put("role", role)
      put("vault_id", vaultId)
    }

  private fun isRole(s: String?): Boolean = s == "owner" || s == "editor" || s == "viewer"

  fun foldMembership(
    vaultId: String,
    anchorPubkeyB64: String,
    serverWitnessPubkeysB64: List<String>,
    events: List<MeshEvent>,
  ): MembershipState {
    val state = MembershipState()

    val ordered =
      events
        .filter { MEMBERSHIP_EVENT_TYPES.contains(it.eventType) }
        .sortedWith(Comparator { a, b ->
          val c = hlcCompare(a, b)
          if (c != 0) c else a.eventId.compareTo(b.eventId)
        })

    fun refuse(e: MeshEvent, reason: String) {
      state.conflicts.add(Conflict(e.eventId, e.eventType, reason))
    }

    fun signerIsActiveOwnerDevice(signerPubkey: String): Boolean {
      val dev = state.devices[signerPubkey]
      if (dev == null || dev.removed) return false
      val member = state.members[dev.accountId]
      return member != null && !member.removed && member.role == "owner"
    }

    fun countActiveOwners(): Int =
      state.members.values.count { !it.removed && it.role == "owner" }

    fun wouldDemoteSoleOwner(accountId: String, newRole: String): Boolean {
      if (newRole == "owner") return false
      val existing = state.members[accountId]
      if (existing == null || existing.removed || existing.role != "owner") return false
      return countActiveOwners() <= 1
    }

    // returns "ok" | "stale" | "invalid"
    fun witnessValid(e: MeshEvent, witness: JSONObject?, tuple: JSONObject?): String {
      if (witness == null || tuple == null) return "invalid"
      if (!witness.has("issued_at_ms") || witness.isNull("issued_at_ms")) return "invalid"
      val issuedAt = witness.optLong("issued_at_ms", Long.MIN_VALUE)
      if (issuedAt == Long.MIN_VALUE) return "invalid"
      if (Math.abs(issuedAt - e.hlcPms) > WITNESS_FRESHNESS_MS) return "stale"
      val sig = witness.strOrNull("sig_b64") ?: return "invalid"
      val msg = MeshEventSig.canonicalizeValue(tuple).toByteArray(Charsets.UTF_8)
      for (pub in serverWitnessPubkeysB64) {
        if (MeshEventSig.verifyRawSignature(msg, sig, pub)) return "ok"
      }
      return "invalid"
    }

    for (e in ordered) {
      if (e.vaultId != vaultId) {
        refuse(e, "wrong_vault")
        continue
      }
      val signer = e.signerDevicePubkey
      val sig = e.eventSigB64
      if (signer == null || sig == null) {
        refuse(e, "missing_signature")
        continue
      }
      if (!MeshEventSig.verifyEventSignature(e.canonicalBytes(), sig, signer)) {
        refuse(e, "bad_signature")
        continue
      }

      val p = e.payload

      when (e.eventType) {
        "vault_member_added" -> {
          val accountId = p.strOrNull("account_id")
          val role = p.strOrNull("role").takeIf { isRole(it) }
          if (accountId == null || role == null) {
            refuse(e, "malformed_payload")
            continue
          }

          if (!state.hasGenesis) {
            if (signer != anchorPubkeyB64 || role != "owner") {
              refuse(e, "not_genesis_eligible")
              continue
            }
            state.hasGenesis = true
            state.members[accountId] = MemberEntry(accountId, "owner", false)
            state.devices[anchorPubkeyB64] =
              DeviceEntry(anchorPubkeyB64, e.deviceId, accountId, false)
            continue
          }

          if (signerIsActiveOwnerDevice(signer)) {
            if (wouldDemoteSoleOwner(accountId, role)) {
              refuse(e, "last_owner")
              continue
            }
            upsertMember(state, accountId, role)
            continue
          }
          // witnessed (online) admission — editor/viewer only, no resurrection.
          if (role == "owner") {
            refuse(e, "witness_role_too_high")
            continue
          }
          val existingMember = state.members[accountId]
          if (existingMember != null && existingMember.removed) {
            refuse(e, "removed_entry_replay")
            continue
          }
          if (wouldDemoteSoleOwner(accountId, role)) {
            refuse(e, "last_owner")
            continue
          }
          val w = p.optJSONObject("witness")
          val inviter = w?.strOrNull("inviter_account_id")
          val tuple =
            if (inviter != null) {
              memberWitnessTuple(
                vaultId,
                accountId,
                inviter,
                role,
                w.optLong("issued_at_ms", 0L),
              )
            } else {
              null
            }
          when (witnessValid(e, w, tuple)) {
            "ok" -> upsertMember(state, accountId, role)
            "stale" -> refuse(e, "witness_stale")
            else -> refuse(e, "signer_not_owner_device")
          }
          continue
        }

        "vault_member_role_changed" -> {
          val accountId = p.strOrNull("account_id")
          val role = p.strOrNull("role").takeIf { isRole(it) }
          if (accountId == null || role == null) {
            refuse(e, "malformed_payload")
            continue
          }
          if (!signerIsActiveOwnerDevice(signer)) {
            refuse(e, "signer_not_owner_device")
            continue
          }
          val member = state.members[accountId]
          if (member == null || member.removed) {
            refuse(e, "unknown_member_account")
            continue
          }
          if (member.role == "owner" && role != "owner" && countActiveOwners() <= 1) {
            refuse(e, "last_owner")
            continue
          }
          member.role = role
          continue
        }

        "vault_member_removed" -> {
          val accountId = p.strOrNull("account_id")
          if (accountId == null) {
            refuse(e, "malformed_payload")
            continue
          }
          if (!signerIsActiveOwnerDevice(signer)) {
            refuse(e, "signer_not_owner_device")
            continue
          }
          val member = state.members[accountId]
          if (member == null || member.removed) {
            refuse(e, "unknown_member_account")
            continue
          }
          if (member.role == "owner" && countActiveOwners() <= 1) {
            refuse(e, "last_owner")
            continue
          }
          member.removed = true
          for (dev in state.devices.values) {
            if (dev.accountId == accountId) dev.removed = true
          }
          continue
        }

        "vault_device_added" -> {
          val accountId = p.strOrNull("account_id")
          val deviceId = p.strOrNull("device_id")
          val devicePubkey = p.strOrNull("device_pubkey")
          if (accountId == null || deviceId == null || devicePubkey == null) {
            refuse(e, "malformed_payload")
            continue
          }
          val member = state.members[accountId]
          if (member == null || member.removed) {
            refuse(e, "unknown_member_account")
            continue
          }
          if (signerIsActiveOwnerDevice(signer)) {
            bindDevice(state, devicePubkey, deviceId, accountId)
            continue
          }
          if (signer == devicePubkey && e.deviceId == deviceId) {
            val existingDev = state.devices[devicePubkey]
            if (existingDev != null && existingDev.removed) {
              refuse(e, "removed_entry_replay")
              continue
            }
            val w = p.optJSONObject("witness")
            val tuple =
              deviceWitnessTuple(
                vaultId,
                accountId,
                deviceId,
                devicePubkey,
                w?.optLong("issued_at_ms", 0L) ?: 0L,
              )
            when (witnessValid(e, w, tuple)) {
              "ok" -> bindDevice(state, devicePubkey, deviceId, accountId)
              "stale" -> refuse(e, "witness_stale")
              else -> refuse(e, "witness_invalid")
            }
            continue
          }
          refuse(e, "unauthorized")
          continue
        }

        "vault_device_removed" -> {
          val deviceId = p.strOrNull("device_id")
          if (deviceId == null) {
            refuse(e, "malformed_payload")
            continue
          }
          val targets = state.devices.values.filter { it.deviceId == deviceId && !it.removed }
          if (targets.isEmpty()) {
            refuse(e, "unknown_device")
            continue
          }
          val signerDev = state.devices[signer]
          val signerSameAccount =
            signerDev != null &&
              !signerDev.removed &&
              targets.all { it.accountId == signerDev.accountId }
          if (!signerIsActiveOwnerDevice(signer) && !signerSameAccount) {
            refuse(e, "signer_not_owner_device")
            continue
          }
          for (t in targets) t.removed = true
          continue
        }
      }
    }

    return state
  }

  private fun upsertMember(state: MembershipState, accountId: String, role: String) {
    val existing = state.members[accountId]
    if (existing != null) {
      existing.removed = false
      existing.role = role
    } else {
      state.members[accountId] = MemberEntry(accountId, role, false)
    }
  }

  private fun bindDevice(
    state: MembershipState,
    devicePubkey: String,
    deviceId: String,
    accountId: String,
  ) {
    val existing = state.devices[devicePubkey]
    if (existing != null) {
      existing.removed = false
      existing.deviceId = deviceId
      existing.accountId = accountId
    } else {
      state.devices[devicePubkey] = DeviceEntry(devicePubkey, deviceId, accountId, false)
    }
  }

  /**
   * Verify a peer's claimed device against (local ∪ proof) membership events.
   * Local knowledge always merged so a removal we know wins. Port of
   * chain.ts verifyPeerProof.
   */
  fun verifyPeerProof(
    vaultId: String,
    anchorPubkeyB64: String,
    serverWitnessPubkeysB64: List<String>,
    localEvents: List<MeshEvent>,
    proofEvents: List<MeshEvent>,
    claimedDevicePubkeyB64: String,
  ): ProofVerdict {
    val seen = HashSet<String>()
    val merged = ArrayList<MeshEvent>()
    for (e in localEvents + proofEvents) {
      if (seen.contains(e.eventId)) continue
      seen.add(e.eventId)
      merged.add(e)
    }
    val state = foldMembership(vaultId, anchorPubkeyB64, serverWitnessPubkeysB64, merged)
    if (!state.hasGenesis) return ProofVerdict.Fail("no_genesis")
    val dev = state.devices[claimedDevicePubkeyB64] ?: return ProofVerdict.Fail("device_not_bound")
    if (dev.removed) return ProofVerdict.Fail("device_removed")
    val member = state.members[dev.accountId]
    if (member == null || member.removed) return ProofVerdict.Fail("member_removed")
    return ProofVerdict.Ok(member.accountId, member.role, dev.deviceId)
  }
}
