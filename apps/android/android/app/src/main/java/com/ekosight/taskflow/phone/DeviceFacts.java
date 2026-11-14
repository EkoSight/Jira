package com.ekosight.taskflow.phone;

import android.Manifest;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.telecom.TelecomManager;
import org.json.JSONException;
import org.json.JSONObject;

/** What the phone is and what it allows, as TaskFlow's phone list shows it. */
final class DeviceFacts {
    private DeviceFacts() {}

    static String appVersion(Context ctx) {
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return info.versionName == null ? "0" : info.versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }

    /** The phone app that places and records calls (Samsung's Phone, ODialer, Google's Phone…). */
    static String diallerPackage(Context ctx) {
        TelecomManager telecom = ctx.getSystemService(TelecomManager.class);
        return telecom == null ? null : telecom.getDefaultDialerPackage();
    }

    static String diallerLabel(Context ctx, String pkg) {
        if (pkg == null) return null;
        try {
            PackageManager pm = ctx.getPackageManager();
            ApplicationInfo app = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(app));
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    /** For the server: maker, model, Android version, app version, default dialler. */
    static JSONObject info(Context ctx) throws JSONException {
        return new JSONObject()
            .put("maker", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("android_version", Build.VERSION.RELEASE)
            .put("app_version", appVersion(ctx))
            .put("dialler_package", diallerPackage(ctx));
    }

    private static boolean granted(Context ctx, String permission) {
        return ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean canPlaceCalls(Context ctx) {
        return granted(ctx, Manifest.permission.CALL_PHONE) && granted(ctx, Manifest.permission.READ_PHONE_STATE);
    }

    static boolean canReadCallLog(Context ctx) {
        return granted(ctx, Manifest.permission.READ_CALL_LOG);
    }

    static boolean canNotify(Context ctx) {
        return Build.VERSION.SDK_INT < 33 || granted(ctx, Manifest.permission.POST_NOTIFICATIONS);
    }

    /** The permissions as the phone list shows them (checked in the background, without the page). */
    static JSONObject permissions(Context ctx) throws JSONException {
        return new JSONObject()
            .put("phone", canPlaceCalls(ctx) ? "granted" : "denied")
            .put("callLog", canReadCallLog(ctx) ? "granted" : "denied")
            .put("notifications", canNotify(ctx) ? "granted" : "denied");
    }

    static boolean batteryUnrestricted(Context ctx) {
        PowerManager power = ctx.getSystemService(PowerManager.class);
        return power != null && power.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }
}
