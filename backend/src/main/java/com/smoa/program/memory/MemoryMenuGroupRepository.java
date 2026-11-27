package com.smoa.program.memory;

import java.util.List;
import java.util.Optional;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.program.MenuGroupRepository;
import com.smoa.program.MenuLayout.Group;

@Repository
@Profile("local-memory")
public class MemoryMenuGroupRepository implements MenuGroupRepository {
    private volatile List<Group> groups;

    @Override
    public Optional<List<Group>> find() {
        return Optional.ofNullable(groups);
    }

    @Override
    public void save(List<Group> groups) {
        this.groups = List.copyOf(groups);
    }
}
