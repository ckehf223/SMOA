package com.smoa.program.persistence;

import java.util.List;
import java.util.Optional;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.audit.AuditStamp;
import com.smoa.config.LibraryContext;
import com.smoa.program.MenuGroupRepository;
import com.smoa.program.MenuLayout.Group;
import com.smoa.settings.persistence.LibrarySettingsMapper;

@Repository
@Profile({"local", "prod"})
public class MyBatisMenuGroupRepository implements MenuGroupRepository {
    private final LibrarySettingsMapper mapper;
    private final LibraryContext library;
    private final ObjectMapper json;

    public MyBatisMenuGroupRepository(LibrarySettingsMapper mapper, LibraryContext library, ObjectMapper json) {
        this.mapper = mapper;
        this.library = library;
        this.json = json;
    }

    @Override
    public Optional<List<Group>> find() {
        String value = mapper.selectWebMenuGroups(library.id());
        if (value == null) return Optional.empty();
        try {
            return Optional.of(List.copyOf(json.readValue(value, new TypeReference<List<Group>>() { })));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("저장된 메뉴 구성을 읽을 수 없습니다.");
        }
    }

    @Override
    public void save(List<Group> groups) {
        try {
            mapper.saveWebMenuGroups(library.id(), json.writeValueAsString(groups), AuditStamp.current());
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("메뉴 구성 저장에 실패했습니다.");
        }
    }
}
