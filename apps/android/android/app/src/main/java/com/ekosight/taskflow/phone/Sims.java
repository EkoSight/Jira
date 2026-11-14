package com.ekosight.taskflow.phone;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Build;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The phone's SIMs, the company one among them, and how the call log names it.
 * Needs the phone permission; without it every answer is empty (each call
 * catches the SecurityException Android throws).
 */
@SuppressLint("MissingPermission")
final class Sims {
    private Sims() {}

    static List<SubscriptionInfo> active(Context ctx) {
        SubscriptionManager subs = ctx.getSystemService(SubscriptionManager.class);
        if (subs == null) return new ArrayList<>();
        try {
            List<SubscriptionInfo> list = subs.getActiveSubscriptionInfoList();
            return list == null ? new ArrayList<>() : list;
        } catch (SecurityException e) {
            return new ArrayList<>();
        }
    }

    @SuppressWarnings("deprecation")
    static String numberOf(Context ctx, SubscriptionInfo info) {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                SubscriptionManager subs = ctx.getSystemService(SubscriptionManager.class);
                String n = subs == null ? null : subs.getPhoneNumber(info.getSubscriptionId());
                return n == null || n.isEmpty() ? null : n;
            }
            String n = info.getNumber();
            return n == null || n.isEmpty() ? null : n;
        } catch (SecurityException e) {
            return null;
        }
    }

    static String labelOf(SubscriptionInfo info) {
        CharSequence name = info.getDisplayName();
        CharSequence carrier = info.getCarrierName();
        String label = name == null ? "" : name.toString();
        if (carrier != null && carrier.length() > 0 && !label.contains(carrier)) label = label.isEmpty() ? carrier.toString() : label + " (" + carrier + ")";
        return label.isEmpty() ? "SIM " + (info.getSimSlotIndex() + 1) : label;
    }

    static JSONObject describe(Context ctx, SubscriptionInfo info) throws JSONException {
        JSONObject o = new JSONObject()
            .put("id", info.getSubscriptionId())
            .put("slot", info.getSimSlotIndex())
            .put("label", labelOf(info));
        String number = numberOf(ctx, info);
        if (number != null) o.put("number", number);
        return o;
    }

    static SubscriptionInfo find(Context ctx, int subId) {
        for (SubscriptionInfo info : active(ctx)) if (info.getSubscriptionId() == subId) return info;
        return null;
    }

    /** The calling account of a SIM: given to the dialler so the call goes out on that SIM. */
    static PhoneAccountHandle handleFor(Context ctx, int subId) {
        if (subId < 0) return null;
        TelecomManager telecom = ctx.getSystemService(TelecomManager.class);
        if (telecom == null) return null;
        try {
            SubscriptionInfo info = find(ctx, subId);
            for (PhoneAccountHandle h : telecom.getCallCapablePhoneAccounts()) {
                if (matches(ctx, h, subId, info)) return h;
            }
        } catch (SecurityException e) {
            return null;
        }
        return null;
    }

    /** How the call log names the company SIM (its PHONE_ACCOUNT_ID values). Empty when the phone does not say. */
    static Set<String> accountIds(Context ctx, int subId) {
        Set<String> out = new HashSet<>();
        if (subId < 0) return out;
        TelecomManager telecom = ctx.getSystemService(TelecomManager.class);
        if (telecom == null) return out;
        try {
            SubscriptionInfo info = find(ctx, subId);
            for (PhoneAccountHandle h : telecom.getCallCapablePhoneAccounts()) {
                if (matches(ctx, h, subId, info)) out.add(h.getId());
            }
        } catch (SecurityException e) {
            out.clear();
        }
        return out;
    }

    @SuppressWarnings("deprecation")
    private static boolean matches(Context ctx, PhoneAccountHandle h, int subId, SubscriptionInfo info) {
        if (Build.VERSION.SDK_INT >= 30) {
            TelephonyManager telephony = ctx.getSystemService(TelephonyManager.class);
            if (telephony != null) {
                try {
                    return telephony.getSubscriptionId(h) == subId;
                } catch (SecurityException e) {
                    // fall through to the older ways
                }
            }
        }
        String id = h.getId();
        if (id == null) return false;
        if (id.equals(String.valueOf(subId))) return true;
        String iccId = info == null ? null : info.getIccId();
        return iccId != null && !iccId.isEmpty() && id.startsWith(iccId);
    }
}
