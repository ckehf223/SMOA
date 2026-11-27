package com.smoa;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class SmoaApplication {

    public static void main(String[] args) {
        SpringApplication.run(SmoaApplication.class, args);
    }
}
