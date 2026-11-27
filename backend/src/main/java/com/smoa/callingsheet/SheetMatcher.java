package com.smoa.callingsheet;

import java.util.Comparator;
import java.util.Locale;
import java.time.Instant;
import java.time.ZoneOffset;

/**
 * 필터·정렬의 메모리 구현. Mapper XML 의 WHERE/ORDER BY 와 같은 의미를 갖도록 유지한다(양쪽을 함께 고칠 것).
 * 범위(ScopeSpec)·삭제 여부·필터를 모두 적용한 뒤에야 행이 목록·집계·내보내기에 들어간다.
 */
public final class SheetMatcher {

    private SheetMatcher() {
    }

    public static boolean matches(SheetRow r, SheetQuery f, ScopeSpec scope) {
        if (r.deleted() != f.trash()) {
            return false;
        }
        if (!scope.covers(r.regionCode(), r.districtCode())) {
            return false;
        }
        if (f.regionCode() != null && !f.regionCode().equals(r.regionCode())) {
            return false;
        }
        if (f.districtCode() != null && !f.districtCode().equals(r.districtCode())) {
            return false;
        }
        if (f.callStatus() != null && !f.callStatus().equals(r.callStatus())) {
            return false;
        }
        if (f.callResult() != null && !f.callResult().equals(r.callResult())) {
            return false;
        }
        if (f.foundFrom() != null && (r.foundDate() == null || r.foundDate().compareTo(f.foundFrom().toString()) < 0)) {
            return false;
        }
        if (f.foundTo() != null && (r.foundDate() == null || r.foundDate().compareTo(f.foundTo().toString()) > 0)) {
            return false;
        }
        if (f.createdFrom() != null
                && (r.createdAt() == null || Instant.parse(r.createdAt()).isBefore(f.createdFromUtc().toInstant(ZoneOffset.UTC)))) {
            return false;
        }
        if (f.assignedUserId() != null && !f.assignedUserId().equals(r.assignedUserId())) {
            return false;
        }
        boolean unassigned = r.assignedUserId() == null && r.assignedUserName().isEmpty();
        if ("none".equals(f.assigned()) && !unassigned || "any".equals(f.assigned()) && unassigned) {
            return false;
        }
        if ("any".equals(f.manpik()) && r.manpikConfirmedAt() == null
                || "none".equals(f.manpik()) && r.manpikConfirmedAt() != null) {
            return false;
        }
        if (f.roundCode() != null) {
            boolean has = r.rounds().stream().anyMatch(x -> x.code().equals(f.roundCode()));
            if ("none".equals(f.roundState()) ? has : !has) {
                return false;
            }
        }
        if (f.phoneLast4() != null && !f.phoneLast4().equals(r.phoneLast4())) {
            return false;
        }
        if (f.q() != null && !matchesText(r, f.q())) {
            return false;
        }
        return true;
    }

    private static boolean matchesText(SheetRow r, String q) {
        String needle = q.toLowerCase(Locale.ROOT);
        if (q.matches("\\d{4}") && q.equals(r.phoneLast4())) {
            return true;
        }
        for (String s : new String[] {r.targetName(), r.introducerName(), r.residence(), r.preferredPlace(), r.notes(),
                r.consultTopic(), r.callStatus(), r.callResult(), r.assignedUserName(), r.manpikInfo()}) {
            if (s != null && s.toLowerCase(Locale.ROOT).contains(needle)) {
                return true;
            }
        }
        return r.rounds().stream().anyMatch(x -> x.callerName() != null && x.callerName().toLowerCase(Locale.ROOT).contains(needle));
    }

    public static Comparator<SheetRow> comparator(String sort, boolean desc) {
        Comparator<SheetRow> primary = switch (sort == null ? "foundDate" : sort) {
            case "id" -> Comparator.comparingLong(SheetRow::id);
            case "callStatus" -> text(SheetRow::callStatus);
            case "callResult" -> text(SheetRow::callResult);
            case "targetName" -> text(SheetRow::targetName);
            case "introducerName" -> text(SheetRow::introducerName);
            case "assignedUserName" -> text(SheetRow::assignedUserName);
            case "district" -> text(SheetRow::regionCode).thenComparing(text(SheetRow::districtCode));
            case "manpikConfirmedAt" -> text(SheetRow::manpikConfirmedAt);
            case "createdAt" -> text(SheetRow::createdAt);
            case "updatedAt" -> text(SheetRow::updatedAt);
            default -> text(SheetRow::foundDate);
        };
        return (desc ? primary.reversed() : primary).thenComparing(Comparator.comparingLong(SheetRow::id).reversed());
    }

    /** NULL 은 가장 작은 값(MariaDB 와 같음: ASC 에서 앞, DESC 에서 뒤). */
    private static Comparator<SheetRow> text(java.util.function.Function<SheetRow, String> getter) {
        return Comparator.comparing(getter, Comparator.nullsFirst(String.CASE_INSENSITIVE_ORDER));
    }
}
