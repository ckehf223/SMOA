package com.smoa.calling;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalTime;
import java.util.Comparator;
import java.util.HexFormat;

import com.smoa.calling.CallingRepository.Range;

final class CallingAttempts {
    static final Comparator<CallingRecord> NEWEST = Comparator.comparing(CallingRecord::date).reversed()
            .thenComparing(CallingRecord::time, Comparator.nullsLast(Comparator.<LocalTime>reverseOrder()));

    private CallingAttempts() {
    }

    static boolean inRange(CallingRecord row, Range range) {
        var key = row.subject().district();
        return (range.from() == null || !row.date().isBefore(range.from()))
                && (range.to() == null || !row.date().isAfter(range.to()))
                && (range.regionCode() == null || key != null && range.regionCode().equals(key.regionCode()))
                && (range.districtCode() == null || key != null && range.districtCode().equals(key.districtCode()));
    }

    static String targetKey(CallingRecord record) {
        var subject = record.subject();
        var district = subject.district();
        if (subject.id() != null) return digest("linked", subject.id());
        return digest("unlinked", district == null ? "" : district.regionCode(),
                district == null ? "" : district.districtCode(), CallingRules.searchKey(subject.name()),
                CallingRules.searchKey(subject.introducer()));
    }

    static String hash(CallingRecord record) {
        return digest(targetKey(record), record.date().toString(), record.time() == null ? "" : record.time().toString(),
                CallingRules.callerKey(record.caller()), record.round().value(),
                record.outcome().result(), "기타".equals(record.outcome().result())
                        ? CallingRules.searchKey(record.outcome().original()) : "");
    }

    private static String digest(String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String value : values) {
                byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
                digest.update(bytes);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 provider unavailable", e);
        }
    }
}
