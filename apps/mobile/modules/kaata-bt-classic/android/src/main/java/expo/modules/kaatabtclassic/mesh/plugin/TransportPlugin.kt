package expo.modules.kaatabtclassic.mesh.plugin

import expo.modules.kaatabtclassic.mesh.MeshConnection

/**
 * Briar-port phase 1 — the transport Plugin seam (Briar's bramble plugin model).
 *
 * Briar's whole mesh is built on a small set of transport plugins behind one
 * interface (Plugin / DuplexPlugin); the engine knows nothing about Bluetooth vs
 * TCP vs WiFi-Direct — it just starts plugins, polls them, and dispatches the
 * connections they produce. kaata's MeshEngine was a BT-only monolith; this
 * introduces the same seam so Bluetooth, WiFi-LAN, and WiFi-hotspot become
 * interchangeable plugins (LAN + hotspot land in later phases).
 *
 * See docs/briar-port-plan.md.
 */

/** Which proximity transport a plugin speaks. */
enum class TransportId {
  BLUETOOTH,
  LAN,
  HOTSPOT,
}

/** Lifecycle state of a plugin (mirrors Briar's Plugin.State). */
enum class PluginState {
  STARTING,
  ACTIVE,
  INACTIVE,
  DISABLED,
}

/**
 * Engine-facing callback a plugin uses to surface connections + state. In phase 1
 * BtcRfcommPlugin still runs sessions inline (via MeshEngine.runSession) and only
 * reports state; phase 3 routes onConnectionOpened through the ConnectionManager.
 */
interface TransportPluginCallback {
  /** A connection (inbound accept or outbound dial) was established + authenticated
   *  enough to hand to the session layer. */
  fun onConnectionOpened(transport: TransportId, conn: MeshConnection)

  /** The plugin's lifecycle state changed (drives the FGS notification + Poller). */
  fun onStateChanged(transport: TransportId, state: PluginState)
}

/** A no-op callback for the phase-1 windowed shim (plugin runs sessions inline). */
object NoopPluginCallback : TransportPluginCallback {
  override fun onConnectionOpened(transport: TransportId, conn: MeshConnection) {}
  override fun onStateChanged(transport: TransportId, state: PluginState) {}
}

/**
 * One proximity transport. Briar's DuplexPlugin: start an accept loop, stop it,
 * and poll() for an outbound discovery/dial sweep on the Poller's cadence.
 */
interface TransportPlugin {
  val id: TransportId

  /** Begin accepting inbound connections (resident until stop()). */
  fun start()

  /** Stop accepting + close everything. Idempotent. */
  fun stop()

  fun state(): PluginState

  /** Do ONE outbound discovery/dial sweep (Poller-driven in phase 2; the phase-1
   *  plugin runs its own continuous dial loop, so this is a hook). */
  fun poll()
}

/** Builds a plugin bound to a context + callback (Briar's PluginFactory). */
interface TransportPluginFactory {
  val id: TransportId

  fun create(
    context: android.content.Context,
    callback: TransportPluginCallback,
  ): TransportPlugin
}
