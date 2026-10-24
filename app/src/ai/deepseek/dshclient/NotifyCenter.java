package ai.deepseek.dshclient;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Local task notifications for DSH Mobile.
 *
 * The app targets SDK 31, so Android 13+ grants POST_NOTIFICATIONS implicitly
 * (the user can still disable it in system settings). No push service is used:
 * notifications are posted by the app itself when a running turn finishes while
 * the conversation is not on screen, or when the OS keeps the WebView alive in
 * the background.
 */
public final class NotifyCenter {
    public static final String CHANNEL_ID = "dsh_tasks";
    public static final String ACTION_NOTIFY = "ai.deepseek.dshclient.NOTIFY";
    private static final String TAG = "DSHNotify";
    /** One stable slot per task notification: a later completion replaces the previous one. */
    private static final int TASK_NOTIFICATION_ID = 1201;

    private NotifyCenter() {}

    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                    "DSH 任务通知", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("DeepSeek Harness 任务完成 / 失败提醒");
            ch.enableVibration(true);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.w(TAG, "ensureChannel failed", e);
        }
    }

    public static void post(Context ctx, String title, String body) {
        try {
            ensureChannel(ctx);
            NotificationManager nm = (NotificationManager)
                    ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Intent open = new Intent(ctx, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                b = new Notification.Builder(ctx, CHANNEL_ID);
            } else {
                b = new Notification.Builder(ctx);
            }
            String t = (title == null || title.length() == 0) ? "DeepSeek Harness" : title;
            String text = body == null ? "" : body;
            b.setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle(t)
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setContentIntent(pi)
                    .setWhen(System.currentTimeMillis());
            nm.notify(TASK_NOTIFICATION_ID, b.build());
            Log.i(TAG, "posted: " + t);
        } catch (Exception e) {
            Log.e(TAG, "post failed", e);
        }
    }
}
