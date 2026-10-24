package ai.deepseek.dshclient;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Exported explicit-broadcast hook for posting a local notification from adb or
 * another trusted automation, e.g.:
 *
 *   adb shell am broadcast -n ai.deepseek.dshclient/.NotifyReceiver \
 *       -a ai.deepseek.dshclient.NOTIFY \
 *       --es title "DSH 任务完成" --es body "仓库已推送"
 *
 * The receiver only posts a notification (no data access), so it is safe to
 * export; the in-app notification path uses the same NotifyCenter.
 */
public class NotifyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action != null && !NotifyCenter.ACTION_NOTIFY.equals(action)) return;
        NotifyCenter.post(context,
                intent.getStringExtra("title"),
                intent.getStringExtra("body"));
    }
}
