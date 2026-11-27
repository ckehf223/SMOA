package com.smoa.program;

import java.util.List;
import java.util.Optional;

public interface MenuGroupRepository {
    /** 빈 목록은 저장된 루트 전용 배치이며, 미저장은 기본 배치를 사용한다. */
    Optional<List<MenuLayout.Group>> find();

    void save(List<MenuLayout.Group> groups);
}
