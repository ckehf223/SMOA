package com.smoa.afterreport;

import java.io.IOException;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;

import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.afterreport.AfterReportData.Draft;
import com.smoa.afterreport.AfterReportData.Filter;
import com.smoa.afterreport.AfterReportData.Payload;
import com.smoa.afterreport.AfterReportData.ReportKey;
import com.smoa.afterreport.AfterReportData.Role;
import com.smoa.afterreport.AfterReportData.Row;
import com.smoa.common.ApiException;
import com.smoa.config.LibraryContext;
import com.smoa.config.SmoaProperties;
import com.smoa.crypto.ContactCrypto;
import com.smoa.permission.DistrictKey;

@Repository
@Profile({"local", "prod"})
class MyBatisAfterReportRepository implements AfterReportRepository {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final AfterReportMapper mapper;
    private final String libraryId;
    private final ContactCrypto crypto;

    MyBatisAfterReportRepository(AfterReportMapper mapper, LibraryContext library, SmoaProperties properties) {
        this.mapper = mapper;
        this.libraryId = library.id();
        String keyFile = properties.contact().keyFile();
        this.crypto = keyFile == null || keyFile.isBlank() ? null : ContactCrypto.fromKeyFile(Path.of(keyFile.strip()));
    }

    @Override
    @Transactional(readOnly = true)
    public Results find(Filter filter) {
        if (filter.districts().isEmpty()) {
            return new Results(List.of(), 0);
        }
        long total = mapper.count(libraryId, filter);
        return new Results(total > filter.offset()
                ? mapper.find(libraryId, filter).stream().map(this::decode).toList() : List.of(), total);
    }

    @Override
    @Transactional(readOnly = true)
    public void visit(Filter filter, Consumer<Row> visitor) {
        if (filter.districts().isEmpty()) {
            return;
        }
        try (var rows = mapper.scan(libraryId, filter)) {
            for (var row : rows) {
                visitor.accept(decode(row));
            }
        } catch (IOException failure) {
            throw storageUnavailable();
        }
    }

    @Override
    @Transactional
    public Row save(Draft draft) {
        ReportKey key = draft.key();
        String token = UUID.randomUUID().toString();
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("libraryId", libraryId);
        values.put("regionCode", key.district().regionCode());
        values.put("districtCode", key.district().districtCode());
        values.put("date", key.date());
        values.put("slot", key.slot());
        values.put("token", token);
        values.put("payload", encode(draft.payload(), key, token));
        values.put("accountId", draft.accountId());
        if (key.role() == Role.ORGANIZER) {
            mapper.upsertOrganizer(values);
            return decode(mapper.findOrganizer(libraryId, key));
        }
        mapper.insertParticipant(values);
        long id = ((Number) values.get("id")).longValue();
        return decode(mapper.findParticipant(libraryId, id, key));
    }

    private String encode(Payload payload, ReportKey key, String token) {
        ContactCrypto cipher = requiredCrypto();
        try {
            return cipher.seal(JSON.writeValueAsString(payload), aad(key, token));
        } catch (JsonProcessingException | ContactCrypto.ContactCryptoException e) {
            throw storageUnavailable();
        }
    }

    private Row decode(Map<String, Object> row) {
        ContactCrypto cipher = requiredCrypto();
        if (row == null) {
            throw storageUnavailable();
        }
        try {
            ReportKey key = new ReportKey(LocalDate.parse((String) row.get("reportDate")),
                    (String) row.get("slotCode"), new DistrictKey((String) row.get("regionCode"),
                            (String) row.get("districtCode")), Role.valueOf((String) row.get("reportRole")));
            String payload = cipher.open((String) row.get("payload"), List.of(aad(key, (String) row.get("token"))));
            return new Row(String.valueOf(row.get("reportId")), key, JSON.readValue(payload, Payload.class),
                    (String) row.get("updatedAt"));
        } catch (JsonProcessingException | RuntimeException e) {
            throw storageUnavailable();
        }
    }

    private ContactCrypto requiredCrypto() {
        if (crypto == null) {
            throw storageUnavailable();
        }
        return crypto;
    }

    private String aad(ReportKey key, String token) {
        return String.join("\n", "SMOA:AFTRPT:V1", libraryId, key.district().regionCode(),
                key.district().districtCode(), key.date().toString(), key.slot(), key.role().name(), token);
    }

    private static ApiException storageUnavailable() {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "AFTER_REPORT_STORAGE_UNAVAILABLE",
                "사후 보고 저장소를 이용할 수 없습니다. 관리자에게 문의해 주세요.");
    }
}
