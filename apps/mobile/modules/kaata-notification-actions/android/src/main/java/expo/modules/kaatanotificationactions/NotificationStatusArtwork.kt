package expo.modules.kaatanotificationactions

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import java.util.EnumMap

/** Full-color large-icon artwork. Callers must not mutate or recycle cached bitmaps. */
internal object NotificationStatusArtwork {
  private const val SIZE = 128
  private const val BADGE_CENTER = 104f
  private const val BADGE_RADIUS = 19.2f
  private const val BADGE_OUTLINE = 1.5f

  // Three 128px ARGB images total 192 KiB; no Context is retained.
  private val cache = EnumMap<NotificationStatusIcon, Bitmap>(NotificationStatusIcon::class.java)

  @Synchronized
  fun bitmap(context: Context, status: NotificationStatusIcon): Bitmap =
    cache[status] ?: create(context, status).also { cache[status] = it }

  private fun create(context: Context, status: NotificationStatusIcon): Bitmap {
    val bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val brand = checkNotNull(context.getDrawable(R.drawable.kaata_notification_brand))
    brand.setBounds(0, 0, SIZE, SIZE)
    brand.draw(canvas)

    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    // The complete outline remains inside the bitmap, including antialiasing.
    canvas.drawCircle(BADGE_CENTER, BADGE_CENTER, BADGE_RADIUS + BADGE_OUTLINE, paint)
    paint.color = when (status) {
      NotificationStatusIcon.PENDING -> Color.rgb(0xD2, 0x9A, 0x00)
      NotificationStatusIcon.ACCEPTED -> Color.rgb(0x0A, 0x5A, 0x46)
      NotificationStatusIcon.REJECTED -> Color.rgb(0xA3, 0x42, 0x42)
    }
    canvas.drawCircle(BADGE_CENTER, BADGE_CENTER, BADGE_RADIUS, paint)

    paint.apply {
      color = if (status == NotificationStatusIcon.PENDING) Color.rgb(0x17, 0x17, 0x17) else Color.WHITE
      style = Paint.Style.STROKE
      strokeWidth = 2.8f
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    val cx = BADGE_CENTER
    val cy = BADGE_CENTER
    when (status) {
      NotificationStatusIcon.PENDING -> {
        canvas.drawCircle(cx, cy, 10.5f, paint)
        canvas.drawPath(Path().apply {
          moveTo(cx, cy - 6.5f)
          lineTo(cx, cy)
          lineTo(cx + 5f, cy + 3f)
        }, paint)
      }
      NotificationStatusIcon.ACCEPTED -> canvas.drawPath(Path().apply {
        moveTo(cx - 8f, cy)
        lineTo(cx - 2f, cy + 6f)
        lineTo(cx + 9f, cy - 6f)
      }, paint)
      NotificationStatusIcon.REJECTED -> canvas.drawPath(Path().apply {
        moveTo(cx - 6.5f, cy - 6.5f)
        lineTo(cx + 6.5f, cy + 6.5f)
        moveTo(cx + 6.5f, cy - 6.5f)
        lineTo(cx - 6.5f, cy + 6.5f)
      }, paint)
    }
    return bitmap
  }
}
