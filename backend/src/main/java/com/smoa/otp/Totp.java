package com.smoa.otp;

import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.util.Locale;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class Totp {
    static final int PERIOD_SECONDS = 30;
    private static final String BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    private Totp() {}

    static String code(byte[] secret, long step, int digits) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(secret, "HmacSHA1"));
            byte[] digest = mac.doFinal(ByteBuffer.allocate(Long.BYTES).putLong(step).array());
            int offset = digest[digest.length - 1] & 15;
            int binary = ByteBuffer.wrap(digest, offset, Integer.BYTES).getInt() & Integer.MAX_VALUE;
            int modulus = digits == 8 ? 100_000_000 : 1_000_000;
            String value = Integer.toString(binary % modulus);
            return "0".repeat(digits - value.length()) + value;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("OTP 코드를 계산할 수 없습니다.");
        }
    }

    static String encode(byte[] bytes) {
        StringBuilder output = new StringBuilder((bytes.length * 8 + 4) / 5);
        int bits = 0;
        int buffer = 0;
        for (byte b : bytes) {
            buffer = (buffer << 8) | (b & 255);
            bits += 8;
            while (bits >= 5) {
                bits -= 5;
                output.append(BASE32.charAt((buffer >>> bits) & 31));
            }
        }
        if (bits != 0) {
            output.append(BASE32.charAt((buffer << (5 - bits)) & 31));
        }
        return output.toString();
    }

    static byte[] decode(String value) {
        String input = value.strip().toUpperCase(Locale.ROOT);
        int padding = input.indexOf('=');
        if (padding >= 0) {
            int padLength = input.length() - padding;
            if (padLength > 6 || input.length() % 8 != 0
                    || !input.substring(padding).equals("=".repeat(padLength))) {
                throw new IllegalArgumentException("OTP 키 형식이 올바르지 않습니다.");
            }
            input = input.substring(0, padding);
        }
        if (input.length() < 32 || input.length() > 103) {
            throw new IllegalArgumentException("OTP 키 형식이 올바르지 않습니다.");
        }
        byte[] result = new byte[input.length() * 5 / 8];
        int bits = 0;
        int buffer = 0;
        int index = 0;
        for (int i = 0; i < input.length(); i++) {
            int digit = BASE32.indexOf(input.charAt(i));
            if (digit < 0) {
                throw new IllegalArgumentException("OTP 키 형식이 올바르지 않습니다.");
            }
            buffer = (buffer << 5) | digit;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                result[index++] = (byte) (buffer >>> bits);
            }
        }
        if (!encode(result).equals(input)) {
            throw new IllegalArgumentException("OTP 키 형식이 올바르지 않습니다.");
        }
        return result;
    }
}
