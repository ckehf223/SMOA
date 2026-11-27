package com.smoa.reference.persistence;

import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.permission.DistrictKey;
import com.smoa.reference.District;
import com.smoa.reference.ReferenceRepository;
import com.smoa.reference.Region;

/** local/prod 어댑터: 조직 테이블(ORGMSTR/ORGDTL)을 읽기 전용으로 조회한다. 형식이 맞지 않는 코드는 건너뛰고 경고만 남긴다. */
@Repository
@Profile({"local", "prod"})
public class MyBatisReferenceRepository implements ReferenceRepository {

    private static final Logger log = LoggerFactory.getLogger(MyBatisReferenceRepository.class);

    private final ReferenceMapper mapper;

    public MyBatisReferenceRepository(ReferenceMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public List<Region> regions() {
        return mapper.selectRegions().stream()
                .map(r -> new Region(r.regionCode, r.name, Boolean.TRUE.equals(r.active))).toList();
    }

    @Override
    public List<District> districts() {
        return mapper.selectDistricts().stream().map(MyBatisReferenceRepository::toDistrict)
                .flatMap(Optional::stream).sorted(Comparator.comparing(District::key)).toList();
    }

    @Override
    public Optional<District> findDistrict(DistrictKey key) {
        return districts().stream().filter(d -> d.key().equals(key)).findFirst();
    }

    @Override
    public Set<DistrictKey> activeDistricts() {
        Set<DistrictKey> keys = new HashSet<>();
        for (DistrictRow row : mapper.selectActiveDistricts()) {
            toDistrict(row).ifPresent(d -> keys.add(d.key()));
        }
        return keys;
    }

    private static Optional<District> toDistrict(DistrictRow d) {
        if (!DistrictKey.valid(d.regionCode, d.districtCode)) {
            log.warn("형식이 맞지 않는 지역·구역 코드를 건너뜁니다(코드 길이/문자 확인 필요).");
            return Optional.empty();
        }
        return Optional.of(new District(new DistrictKey(d.regionCode, d.districtCode), d.name,
                Boolean.TRUE.equals(d.active)));
    }
}
