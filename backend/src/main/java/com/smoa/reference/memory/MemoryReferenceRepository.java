package com.smoa.reference.memory;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import com.smoa.permission.DistrictKey;
import com.smoa.reference.District;
import com.smoa.reference.ReferenceRepository;
import com.smoa.reference.Region;

/**
 * local-memory 전용 가상 지역·구역. 실제 조직 자료가 아니다(운영 프로파일에는 이 빈이 없다).
 * R1: D1·D2, R2: D1·D3(R1/D1 과 R2/D1 은 별개), R9(비활성 지역)/D1, R1/D8(비활성 구역).
 */
@Repository
@Profile("local-memory")
public class MemoryReferenceRepository implements ReferenceRepository {

    private final List<Region> regions = List.of(
            new Region("R1", "가상 지역 1", true),
            new Region("R2", "가상 지역 2", true),
            new Region("R9", "가상 비활성 지역", false));

    private final List<District> districts = List.of(
            new District(new DistrictKey("R1", "D1"), "가상 1구역", true),
            new District(new DistrictKey("R1", "D2"), "가상 2구역", true),
            new District(new DistrictKey("R1", "D8"), "가상 비활성 구역", false),
            new District(new DistrictKey("R2", "D1"), "가상 1구역", true),
            new District(new DistrictKey("R2", "D3"), "가상 3구역", true),
            new District(new DistrictKey("R9", "D1"), "가상 1구역", true)).stream()
            .sorted(Comparator.comparing(District::key)).toList();

    @Override
    public List<Region> regions() {
        return regions;
    }

    @Override
    public List<District> districts() {
        return districts;
    }

    @Override
    public Optional<District> findDistrict(DistrictKey key) {
        return districts.stream().filter(d -> d.key().equals(key)).findFirst();
    }

    @Override
    public Set<DistrictKey> activeDistricts() {
        Set<String> activeRegions = regions.stream().filter(Region::active).map(Region::regionCode)
                .collect(Collectors.toSet());
        return districts.stream().filter(District::active).map(District::key)
                .filter(k -> activeRegions.contains(k.regionCode())).collect(Collectors.toSet());
    }
}
