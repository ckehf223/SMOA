package com.smoa.calling;

import java.time.LocalDate;
import java.time.LocalTime;

import com.smoa.permission.DistrictKey;

record CallingRecord(
        String id, long rowVersion, Subject subject,
        LocalDate date, LocalTime time, String caller, Round round, Outcome outcome, String notes) {

    record Subject(String id, String name, String code, String introducer, DistrictKey district,
            String className, LocalDate foundDate, boolean deleted) {
    }

    record Round(int number, String name) {
        String label() {
            return name == null ? CallingRules.ROUNDS.get(number) : name;
        }

        String value() {
            return name == null ? Integer.toString(number) : name;
        }
    }

    record Outcome(String result, String original, String reported) {
        String display() {
            return original == null ? reported == null ? result : reported : original;
        }
    }

    CallingRecord identity(String nextId, long version) {
        return new CallingRecord(nextId, version, subject, date, time, caller, round, outcome, notes);
    }
}
