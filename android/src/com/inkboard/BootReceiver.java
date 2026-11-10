package com.inkboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        DeviceSetup.apply(c);
        BatteryCare.apply(c);
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        }
    }
}
