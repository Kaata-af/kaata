package expo.modules.kaatabtclassic.mesh

import android.bluetooth.BluetoothSocket
import android.util.Log
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Native mesh framed connection — Briar-parity rewrite, step 2.
 *
 * Byte-faithful Kotlin port of lib/mesh/transport-btc.ts BtcMeshConnection: the
 * length-prefixed JSON-over-RFCOMM framing + per-frame ChaCha20-Poly1305 AEAD.
 *
 * WIRE FORMAT (must match transport-btc.ts exactly):
 *   [4B BE frame_len][frame]
 *   frame = [7B header][body]
 *   header = frame_id(u16 BE) | chunk_index=0 | chunk_count=1 | plaintext_len(u24 BE)
 *   body   = AEAD ciphertext (plaintext_len + 16B tag) once an AEAD is installed,
 *            else raw plaintext (the pre-handshake Hello/PoP frames).
 *   The 7-byte header is the AEAD AAD.
 *
 * Unlike the JS version (which receives bytes via native events through an
 * adapter), this owns the BluetoothSocket streams directly: a dedicated reader
 * thread blocks on InputStream.read, drains whole frames, opens the AEAD, parses
 * JSON, and hands each message to a blocking queue. sendJson writes synchronously.
 * That is exactly Briar's model — a plain blocking I/O thread per connection,
 * living as long as the (FGS) process, no JS runtime in the loop.
 */
class MeshConnection private constructor(
  private val input: InputStream,
  private val output: OutputStream,
  private val closer: () -> Unit,
  /** Remote address for cache/dedup — a BT MAC, or "ip:port" for LAN/hotspot. */
  val remoteMac: String?,
) {
  companion object {
    private const val TAG = "MeshConnection"
    const val FRAME_HEADER_BYTES = 7
    const val MAX_PLAINTEXT_BYTES = 0xffffff
    val MAX_FRAME_BYTES = FRAME_HEADER_BYTES + MAX_PLAINTEXT_BYTES + MeshCrypto.TAG_BYTES

    private val CLOSED = Any() // sentinel pushed onto the queue on close

    /** Wrap a Bluetooth RFCOMM socket. */
    fun fromBluetooth(socket: BluetoothSocket, remoteMac: String?): MeshConnection =
      MeshConnection(socket.inputStream, socket.outputStream, { socket.close() }, remoteMac)

    /** Wrap a TCP socket (LAN / WiFi-hotspot). Same framing + AEAD as RFCOMM —
     *  the protocol is transport-agnostic, so the handshake/anti-entropy modules
     *  run over this unchanged. */
    fun fromTcp(socket: Socket, remoteAddr: String?): MeshConnection =
      MeshConnection(
        socket.getInputStream(),
        socket.getOutputStream(),
        {
          try {
            socket.close()
          } catch (e: Throwable) {
            /* ignore */
          }
        },
        remoteAddr,
      )
  }

  /** Set by the handshake once verified. */
  @Volatile var remoteDeviceId: String? = null

  private val queue = LinkedBlockingQueue<Any>()
  @Volatile private var aead: MeshCrypto.AeadContext? = null
  @Volatile private var closed = false
  private var outFrameId = 0
  private val writeLock = Any()

  private val reader = Thread({ readLoop() }, "kaata-mesh-conn").apply { isDaemon = true }

  init {
    reader.start()
  }

  fun installAead(ctx: MeshCrypto.AeadContext) {
    aead = ctx
  }

  fun isOpen(): Boolean = !closed

  // --- reader thread: blocking read -> drain frames -> enqueue JSON ----------

  private fun readLoop() {
    val buf = ByteArray(8192)
    var recvBuf = ByteArray(0)
    try {
      while (!closed) {
        val n = input.read(buf)
        if (n < 0) break // EOF
        if (n == 0) continue
        recvBuf = recvBuf + buf.copyOf(n)
        recvBuf = drainFrames(recvBuf) ?: break // null => fatal frame error
      }
    } catch (e: Throwable) {
      if (!closed) Log.d(TAG, "read loop ended: ${e.message}")
    } finally {
      markClosed()
    }
  }

  /** Returns the leftover buffer, or null on a fatal framing/AEAD error. */
  private fun drainFrames(initial: ByteArray): ByteArray? {
    var rb = initial
    while (true) {
      if (closed) return rb
      if (rb.size < 4) return rb
      val frameLen = readBE32(rb, 0)
      if (frameLen < FRAME_HEADER_BYTES || frameLen > MAX_FRAME_BYTES) {
        Log.w(TAG, "bad frame_len $frameLen — closing")
        return null
      }
      if (rb.size < 4 + frameLen) return rb
      val frame = rb.copyOfRange(4, 4 + frameLen)
      if (!handleFrame(frame)) return null
      rb = rb.copyOfRange(4 + frameLen, rb.size)
    }
  }

  /** Returns false on a fatal error (caller closes). */
  private fun handleFrame(frame: ByteArray): Boolean {
    val header = frame.copyOfRange(0, FRAME_HEADER_BYTES)
    val body = frame.copyOfRange(FRAME_HEADER_BYTES, frame.size)
    val declaredPlainLen = readBE24(header, 4)

    val plaintext: ByteArray =
      if (aead != null) {
        try {
          MeshCrypto.openChunk(body, header, aead!!)
        } catch (e: Throwable) {
          Log.w(TAG, "AEAD open failed: ${e.message}")
          return false
        }
      } else {
        body
      }

    if (plaintext.size != declaredPlainLen) {
      Log.w(TAG, "length mismatch hdr=$declaredPlainLen actual=${plaintext.size} — closing")
      return false
    }

    val text = String(plaintext, Charsets.UTF_8)
    val obj =
      try {
        JSONObject(text)
      } catch (e: Throwable) {
        Log.w(TAG, "frame not valid JSON object — dropping")
        return true // non-fatal: drop, keep the link
      }
    queue.put(obj)
    return true
  }

  private fun markClosed() {
    if (closed) return
    closed = true
    queue.put(CLOSED)
  }

  // --- outbound --------------------------------------------------------------

  fun sendJson(obj: JSONObject) {
    if (closed) throw MeshCrypto.MeshCryptoError("sendJson on closed connection")
    val plaintext = obj.toString().toByteArray(Charsets.UTF_8)
    if (plaintext.size > MAX_PLAINTEXT_BYTES) {
      throw MeshCrypto.MeshCryptoError("mesh message too large: ${plaintext.size}")
    }
    synchronized(writeLock) {
      val frameId = (outFrameId++ and 0xffff)
      val header = buildHeader(frameId, plaintext.size)
      val ctx = aead
      val body = if (ctx != null) MeshCrypto.sealChunk(plaintext, header, ctx) else plaintext
      val frameLen = FRAME_HEADER_BYTES + body.size
      val out = ByteArray(4 + frameLen)
      out[0] = ((frameLen ushr 24) and 0xff).toByte()
      out[1] = ((frameLen ushr 16) and 0xff).toByte()
      out[2] = ((frameLen ushr 8) and 0xff).toByte()
      out[3] = (frameLen and 0xff).toByte()
      header.copyInto(out, 4)
      body.copyInto(out, 4 + FRAME_HEADER_BYTES)
      output.write(out)
      output.flush()
    }
  }

  /**
   * Block up to timeoutMs for the next message. Returns null on timeout or close
   * (mirrors recvJSON resolving {__closed:true} / rejecting on timeout — callers
   * treat null as "give up this session").
   */
  fun recvJson(timeoutMs: Long): JSONObject? {
    val item = queue.poll(timeoutMs, TimeUnit.MILLISECONDS) ?: return null
    if (item === CLOSED) {
      // Put it back so a subsequent recv also sees closed.
      queue.put(CLOSED)
      return null
    }
    return item as JSONObject
  }

  fun close() {
    markClosed()
    try {
      closer()
    } catch (e: Throwable) {
      /* ignore */
    }
  }

  // --- framing helpers (match transport-btc.ts) ------------------------------

  private fun readBE32(buf: ByteArray, off: Int): Int =
    ((buf[off].toInt() and 0xff) shl 24) or
      ((buf[off + 1].toInt() and 0xff) shl 16) or
      ((buf[off + 2].toInt() and 0xff) shl 8) or
      (buf[off + 3].toInt() and 0xff)

  private fun readBE24(buf: ByteArray, off: Int): Int =
    ((buf[off].toInt() and 0xff) shl 16) or
      ((buf[off + 1].toInt() and 0xff) shl 8) or
      (buf[off + 2].toInt() and 0xff)

  private fun buildHeader(frameId: Int, plaintextLen: Int): ByteArray {
    val h = ByteArray(FRAME_HEADER_BYTES)
    h[0] = ((frameId ushr 8) and 0xff).toByte()
    h[1] = (frameId and 0xff).toByte()
    h[2] = 0 // chunk_index — RFCOMM carries the whole message in one frame
    h[3] = 1 // chunk_count
    h[4] = ((plaintextLen ushr 16) and 0xff).toByte()
    h[5] = ((plaintextLen ushr 8) and 0xff).toByte()
    h[6] = (plaintextLen and 0xff).toByte()
    return h
  }
}
